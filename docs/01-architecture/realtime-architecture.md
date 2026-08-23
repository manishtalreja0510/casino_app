# Real-Time Architecture (Socket.IO)

The `realtime` module (`apps/api`): Socket.IO gateways carrying all gameplay traffic. REST handles everything else (`docs/03-api/api-conventions.md`). Built in P5; consumed by the game engine (P6, `docs/01-architecture/game-architecture.md`), matchmaking/lobby (P7), and in-app notifications (P11). Client behavior: `docs/01-architecture/frontend-architecture.md §8–9`.

Normative constraints: the server is authoritative for all timers, turn order, and hidden information (rule 2); Redis never holds financial or recovery truth (rule 7).

## 1. Decision rationale — Socket.IO (ADR-007)

**Problem.** Bidirectional, low-latency gameplay transport that survives horizontal scaling, mobile network flaps, and load balancers, without inventing a protocol stack.

**Chosen.** Socket.IO on Node/NestJS gateways, WebSocket transport primary, `@socket.io/redis-adapter` for multi-instance fan-out.

**Alternatives.**
- *Raw `ws`*: minimal and fast, but we would hand-build everything Socket.IO gives us — reconnection, multiplexed namespaces, rooms, acks, cross-instance adapter. Each is deceptively deep; each hand-built version is a new bug surface in the most latency- and correctness-sensitive part of the platform.
- *Centrifugo*: excellent at scale, but it is a separate stateful service (ops burden, new failure domain) and its model is publish-oriented; our per-action server validation lives naturally in the NestJS process where the engine runs. Recorded as the likely target if/when the realtime tier is extracted (`system-architecture.md §8`).
- *Phoenix-style channels (Elixir)*: arguably the best-in-class runtime for this workload, but a second language/runtime for one tier of a small team's modular monolith fails ADR-003's premise.

**Why Socket.IO.** Rooms/namespaces/acks map 1:1 to our domain (tables, users, per-event confirmation); the Redis adapter makes horizontal scale a config change; it lives in-process with the engine, so action validation has no network hop; the Flutter client library is mature.

**Trade-offs.** Protocol overhead vs raw WS (accepted; payloads are small); Socket.IO's own reconnect/ack semantics are transport-level only — our seq/resume protocol (§7–8) provides the delivery guarantees, not Socket.IO's; polling fallback drags in sticky-session requirements (§5). Full rationale: ADR-007.

## 2. Namespaces & rooms

| Namespace | Purpose | Rooms |
|---|---|---|
| `/lobby` | lobby/table directory updates, matchmaking status, presence | `user:{userId}` (private per-user channel: match found, seat reserved, notifications) |
| `/game` | gameplay only | `table:{tableId}` (persistent tables, e.g. poker), `match:{matchId}` (discrete matches/rounds), `user:{userId}` (private in-game events — the delivery path for per-player `playerView` data) |

Room membership is server-assigned only — clients never join rooms by request; the gateway joins a socket to rooms based on its authenticated session and engine/matchmaking state. Anything player-specific (hole cards, private prompts) is emitted to `user:{userId}`, never to a shared room; shared rooms carry only information every member may see (enforced upstream by `playerView`, `game-architecture.md §7`).

## 3. Authentication handshake

Per the canonical auth model (`docs/04-security/authentication-security.md`, ADR-013):

1. Client calls REST `POST /api/v1/auth/ws-ticket` (authenticated, device-bound) → one-time WS ticket: short TTL (~30 s), single-use, bound to session + device, stored in Redis.
2. Client opens the Socket.IO connection with the ticket in the handshake auth payload.
3. Gateway atomically consumes the ticket (Redis `GETDEL`) — replay of a ticket fails. Socket is bound to `{userId, sessionId, deviceId}` and joined to `user:{userId}`.
4. Session revocation (logout-everywhere, freeze, kill-switch) force-disconnects the user's sockets via an internal event on the adapter.

Why tickets instead of JWT-at-handshake: no long-lived credential in WS query strings/logs, single-use semantics kill replay, and revocation checks happen at mint time on the REST path where the full guard stack (rate limits, device signature) already runs.

## 4. Connection lifecycle & heartbeats

- Socket.IO ping/pong heartbeats tuned for mobile (interval ~25 s, timeout ~20 s) detect dead connections; the gateway additionally tracks per-socket liveness for presence.
- A heartbeat-declared-dead socket is a *transport* fact only. What it means for a match (grace period, sit-out, auto-fold, forfeit) is the game's disconnect policy, delegated entirely to the game contract (`game-architecture.md §9`); the realtime layer just notifies the engine `playerConnectionChanged(matchId, playerId, connected, at)`.
- Presence (in `/lobby`) is Redis-backed with TTL refresh, so an instance crash expires its sockets' presence rather than leaking it.

## 5. Horizontal scaling

- All gateway instances are stateless; `@socket.io/redis-adapter` fans room emits across instances. A client of table T on instance A receives events emitted by the engine worker on instance B.
- **WS transport primary.** Clients connect `transports: ['websocket']`; HTTP long-polling fallback is disabled by default. This removes the multi-request handshake that forces session affinity.
- **Sticky-session note:** if polling fallback is ever enabled (e.g. for hostile middleboxes), the LB must pin by connection (cookie/IP-hash) because polling spreads one logical session over many HTTP requests. Keep it off unless P14 field data forces it; sticky sessions complicate rolling deploys and instance drain.
- Scale ceiling of the Redis-adapter pattern is a P14 load-test subject; the extraction path for the realtime tier is pre-planned (`system-architecture.md §8`).

## 6. Event envelope

Versioned event schemas live in `packages/contracts` (WS event schemas → generated Dart models). Every server→client event:

```jsonc
{
  "v": 1,                      // envelope/schema version
  "seq": 4711,                 // per-room monotonic sequence (see §7)
  "ts": "2026-08-23T10:15:04.211Z", // server timestamp (UTC)
  "room": "match:0198f3e2-…",  // room the seq belongs to
  "type": "game:event",        // event names per websocket-conventions.md §3; occurrences are payload subtypes
  "payload": { }               // schema per type, versioned in contracts
}
```

- `seq` is allocated per room by the emitting side (engine for `match:`/`table:`, notification/matchmaking services for `user:`), monotonically increasing for the room's lifetime. Clients drop already-seen `seq` (duplicate) and treat gaps as a resume trigger — this, not Socket.IO delivery, is the ordering/exactly-once-apply guarantee.
- `ts` is the server clock; client countdowns render against it (cosmetic only, §9).
- Breaking payload changes get a new schema version in contracts plus the API-versioning/forced-update treatment (rule 23).

## 7. Client acks

Client→server messages use Socket.IO acks as the RPC pattern: the gateway ack carries `{accepted: true, seq}` or `{accepted: false, error: {code, …}}` with codes from the shared contracts registry (e.g. `GAME_NOT_YOUR_TURN`, `GAME_INVALID_ACTION`, `RATE_LIMITED` — `websocket-conventions.md §9`). Client actions carry a client-generated `actionId` (UUIDv7) so a re-send after an ack timeout is deduplicated server-side (engine keeps recent actionIds per match) — the client may retry safely without double-acting. Server→client events are **not** individually acked; the `seq` protocol replaces per-event acks (cheaper, and recovery is pull-based).

## 8. Resume protocol

Reconnect is the common case on mobile, so it is a first-class protocol, not Socket.IO's built-in buffer (which is per-instance and lost on failover).

1. Every event emitted to `match:{matchId}`/`table:{tableId}` is also appended to a Redis ring buffer (`rt:events:{room}`, a Redis Stream or capped list) with a retention window of **~2 minutes** (config; sized against P14 data).
2. On reconnect: client performs the full auth handshake (§3 — new ticket), then emits `resume(matchId, lastSeq)` where `lastSeq` is the highest contiguously-applied seq it holds.
3. Server checks the ring buffer:
   - **`lastSeq` within window** → replay all events `> lastSeq` in order (private events re-derived/filtered per player — replay never bypasses `playerView`), then a `resume_ok {upToSeq}` marker; client is live.
   - **Too old / buffer missing (Redis restarted, window exceeded)** → `resume_reset`, followed by a full state sync: current `playerView(state, playerId)` snapshot + current `seq` watermark. Client discards local view state and re-renders.
4. Mid-replay gaps (race with live emits) resolve by re-issuing `resume` with the new `lastSeq`; convergence is guaranteed because seq is monotonic.

The fallback (3b) means correctness never depends on the ring buffer: it is a latency/UX optimization. Truth for recovery/disputes is the PG event log (`game-architecture.md §5`), never Redis (rule 7).

## 9. Server tick / turn timer framework

Server-authoritative timers only (rule 2): turn clocks, betting-round timeouts, round ticks (e.g. Crash), grace periods.

- The engine schedules timers via the P5 timer framework: **BullMQ delayed jobs** for coarse timers (seconds+: turn timers, disconnect grace) and an in-process **timer wheel** per engine worker for sub-second ticks (round loops), each guarded by a fencing token so a stale worker's firing is rejected.
- Every timer firing is delivered to the game as `onTimeout(ctx, state, timerId)` (`game-architecture.md §2`) — the game never sets OS timers itself.
- Timer state (deadline, timerId) is part of persisted game state, so crash recovery re-arms timers from the event log; a timer firing is idempotent (already-advanced state ignores a stale timerId).
- **Client timers are cosmetic.** The client renders countdowns from `deadline` timestamps in events; expiry client-side changes UI only. The server acts on its own clock regardless of what the client shows or claims.

## 10. Ingress protection

All client→server events are hostile input (rule 1):

- **Payload validation**: every event validated against its contracts schema at the gateway (shape, size, enum ranges) before reaching any handler; oversize payloads (hard cap, ~4 KB default) are rejected and the socket counted against abuse limits. The engine then re-validates semantically in `reduce`.
- **Rate limiting**: Redis token buckets per socket, per user, and per event class (game actions get a per-turn budget; lobby queries a coarser one). Exceeding → `RATE_LIMITED` ack errors, then disconnect on sustained abuse, then a risk-engine signal (`docs/02-domains/fraud-risk.md`).
- **Backpressure (outbound)**: per-socket send-buffer watermarks; a client that cannot drain (slow network, stalled reader) is disconnected past the high watermark rather than ballooning server memory — it can resume via §8. Room fan-out never blocks the engine: emits are fire-and-forget from the engine's perspective, with the ring buffer + resume covering losses.
- Unauthenticated sockets get one shot: no valid ticket in handshake → immediate disconnect; per-IP connection-attempt limits at gateway and WAF.

## 11. Failure modes

| Failure | Behavior |
|---|---|
| **Redis down** | WS layer degrades hard: no adapter fan-out, no tickets, no ring buffer. Gateways enter maintenance behavior: existing sockets closed with `maintenance` reason, clients back off and retry. **No money/game truth is lost** — engine persists to PG; affected matches recover via snapshot+replay (`game-architecture.md §6`) when Redis returns, or are voided+refunded per policy. Reconciliation verifies escrow (rule 9). |
| **API/WS instance killed** | Its sockets drop; clients reconnect (LB routes to survivors), re-auth, `resume(matchId, lastSeq)` → replay from ring buffer (written by the engine, not the dead instance) — P5 acceptance requires surviving this with zero duplicate-applied events. In-flight BullMQ timers are re-delivered to another worker (at-least-once + fencing). |
| **Client network flap** | Transport drops or heartbeat times out → engine notified → game's disconnect policy runs its grace period. Client reconnects, resumes within window (seamless) or full resync. REST mutations in flight are retried under their idempotency keys. |
| **Redis ring buffer evicted / window exceeded** | `resume_reset` → full `playerView` resync. Never an error state. |
| **Adapter partition (Redis flaky, not down)** | Emits may not reach all instances → clients detect seq gaps → resume storm. Mitigation: resume endpoint is cheap (Redis range read), rate-limited per user, and P14 tests reconnect storms explicitly. |

## 12. Redis vs PostgreSQL responsibilities (realtime scope)

| Data | Store | Nature |
|---|---|---|
| WS tickets, socket/session bindings, presence | Redis | ephemeral, TTL'd |
| Event ring buffers per room (~2 min) | Redis | ephemeral cache for resume |
| Rate-limit buckets, adapter pub/sub | Redis | operational |
| Hot game state | Redis | cache over PG event log (`game-architecture.md §5`) |
| `game_events`, `game_snapshots`, match records, audit | PostgreSQL | **truth** |

Losing Redis interrupts play; it can never lose money or dispute evidence (rules 5, 7; ADR-004/ADR-005).
