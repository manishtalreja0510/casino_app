# WebSocket Conventions (Socket.IO)

The concrete rulebook for the realtime protocol. Architecture and rationale: `../01-architecture/realtime-architecture.md` (ADR-007). REST rules: `api-conventions.md`. Event schemas are normative in `packages/contracts` (versioned WS schemas → generated Dart models in `apps/mobile/packages/api_client`).

## 1. Connection & namespaces

- Single Socket.IO endpoint per environment (behind WAF/CDN, TLS only), `transports: ['websocket']` (polling fallback off; see realtime-architecture §5 for the sticky-session caveat if ever enabled).
- Namespaces: **`/lobby`** (browsing, presence, matchmaking updates) and **`/game`** (match/table traffic). Nothing else; a new namespace is a contracts + ADR-level change.

## 2. Handshake auth — one-time WS ticket

1. Client calls `POST /api/v1/auth/ws-ticket` (authenticated, device-signed REST — spec: `../02-domains/authentication.md` §5) → opaque one-time ticket, **TTL ~30 s, single use**, bound to `{userId, sessionId, deviceId}`, stored hashed in Redis.
2. Client connects with the ticket in the Socket.IO handshake `auth` payload (never in the query string).
3. Gateway consumes it atomically (`GETDEL`) — replay fails; the socket is bound to session+device and auto-joined to `user:{userId}`.
- No valid ticket → immediate disconnect, one attempt, per-IP connection limits apply. JWTs never appear in WS handshakes or logs.
- Session revocation force-disconnects all its sockets. A disconnected client mints a **new** ticket to reconnect — tickets are never reused.

## 3. Event naming

`domain:action`, lower-case, colon-separated. Registered in `packages/contracts`; an event name not in contracts is rejected at the gateway.

| Direction | Examples |
|---|---|
| client→server | `game:action`, `game:resume`, `lobby:subscribe`, `lobby:unsubscribe` |
| server→client | `game:event` (engine occurrences), `game:state` (full playerView snapshot), `game:resume_ok`, `game:resume_reset`, `game:error`, `lobby:update`, `user:notify` |

Fine-grained game occurrences (deal, bet, timeout…) are **payload subtypes inside `game:event`**, not new event names — game modules extend payload schemas, never the protocol.

## 4. Envelope

Every server→client event:

```jsonc
{
  "v": 1,                              // envelope/schema version (§10)
  "seq": 4711,                         // per-room monotonic seq — present on room-scoped events
  "ts": "2026-08-23T10:15:04.211Z",    // server clock, RFC3339 UTC
  "room": "match:0198f3e2-…",          // room the seq belongs to (with seq)
  "type": "game:event",                // mirrors the Socket.IO event name
  "payload": { }                       // schema per type/version in contracts
}
```

- `seq` is allocated per room by the emitter (engine for `match:`/`table:`; matchmaking/notification services for `user:`), monotonic for the room's lifetime. **Present on room-scoped server events**; absent on direct RPC-style replies. Clients drop already-seen `seq` and treat gaps as a resume trigger — this, not Socket.IO delivery, is the ordering/exactly-once-apply guarantee.
- `ts` is the server clock; client countdowns render against event-carried deadlines — cosmetic only (§11).
- Client→server events carry `{v, actionId, payload}` — `actionId` is a client-generated UUIDv7 per logical action (the WS analogue of `Idempotency-Key`).

## 5. Acks, timeouts, retries

- Every client→server event uses a Socket.IO ack as the RPC reply: `{accepted: true, seq}` (the seq at which the action lands) or `{accepted: false, error: {...}}` (§9).
- Ack timeout: **5 s**. On timeout the client re-sends the **same `actionId`**; the server dedupes (engine keeps recent actionIds per match), so retries never double-act. Max 2 retries, then treat as connection failure → reconnect + resume (§7).
- Server→client events are **not** individually acked; the `seq`/resume protocol replaces per-event acks.

## 6. Rooms

| Room | Membership | Content |
|---|---|---|
| `user:{userId}` | auto-joined at handshake | private per-user events (notifications, match assignments) |
| `table:{tableId}` | joined on seat/observe via server decision | table-scoped events (poker) |
| `match:{matchId}` | joined on match start via server decision | match-scoped events |

Clients never join/leave rooms directly — room membership is a server-side effect of domain actions (sit, matchmake, observe). Room names are opaque to clients beyond resume bookkeeping.

## 7. Resume protocol

On reconnect: full handshake (§2, new ticket), then `game:resume {matchId, lastSeq}` where `lastSeq` is the highest **contiguously applied** seq the client holds.

Server replies with exactly one of:

| Reply | When | Client behavior |
|---|---|---|
| replayed events `> lastSeq` in order, then `game:resume_ok {upToSeq}` | `lastSeq` within the Redis ring-buffer window (**~2 min**, config) | apply replayed events like live ones (seq dedup applies); live after the marker |
| `game:resume_reset`, then full `game:state` snapshot + current seq watermark | window exceeded / buffer gone (Redis restart) | discard local view state, re-render from snapshot |

The marker event is the discriminator — the client never guesses. Replay is filtered per recipient (`playerView` — replay never bypasses information hiding, §11). Gaps during replay (race with live emits) → re-issue `game:resume` with the new `lastSeq`; seq monotonicity guarantees convergence. Correctness never depends on the ring buffer — PG event log is truth (rule 7); the buffer is a latency optimization.

## 8. Heartbeats & limits

- Socket.IO ping/pong: `pingInterval` ~25 s, `pingTimeout` ~20 s (mobile-tuned; config per env). Heartbeat death is a transport fact; match consequences (grace, sit-out, auto-fold) are game-defined disconnect policy via the contract.
- **Payload validation**: every inbound event validated against its contracts schema at the gateway (shape, size, enums) before any handler; the engine re-validates semantically in `reduce`. Hard payload cap **~4 KB**; oversize → reject + abuse counter.
- **Rate limits**: Redis token buckets per **connection**, per **user**, and per **event class** (game actions get a per-turn budget; lobby queries a coarser one). Exceeded → `RATE_LIMITED` ack error → disconnect on sustained abuse → risk-engine signal. Connection attempts are limited per IP at gateway and WAF.

## 9. Error convention

WS errors mirror the REST envelope and share the same `packages/contracts` code registry:

```jsonc
{"accepted": false, "error": {"code": "GAME_NOT_YOUR_TURN", "message": "…", "details": {}, "traceId": "…"}}
```

- Solicited errors ride the ack (above). Unsolicited errors (e.g. match voided, session revoked, maintenance drain) are `game:error` / `lobby:update` events with the same `error` object in the payload.
- Cross-cutting codes behave as in REST: `RATE_LIMITED`, `MAINTENANCE` (server drains: emits maintenance, then disconnects; client backs off per §10 of `api-conventions.md` semantics), `UPDATE_REQUIRED` (below min version → refuse handshake; client already hard-blocked on REST).

## 10. Versioning & deprecation

- The envelope `v` field versions the protocol; payload schemas are versioned in contracts. Evolution is **additive within `v`** (new optional payload fields, new payload subtypes, new event names — clients ignore unknowns, same loose-out/strict-in stance as REST).
- Breaking change ⇒ new `v`; server dual-emits (or translates) old + new for a **deprecation window aligned with the forced-update cycle**: the old `v` is dropped only after the min-version floor (426 path, ADR-017) has passed the last client speaking it. Sideload lag of weeks is the design assumption, not an exception.
- A client receiving an envelope `v` above what it understands treats it as a forced-update signal (check version endpoint), never as a parse-and-hope.

## 11. Security rules

- **No hidden information is ever broadcast to a room.** Room events carry only public state; private state goes per-socket, derived through `playerView(state, playerId)` at the contract level (rule 2). This holds for live emits, ring-buffer replay, and full resyncs alike — the serializer boundary is `playerView`, tested adversarially (P9 protocol tests).
- **The server never trusts client timers, ordering, or timestamps.** Turn deadlines fire server-side (BullMQ delayed jobs / engine timer wheel with fencing); client countdowns are cosmetic; client-claimed send times and arrival order carry no semantic weight. Out-of-turn or expired actions are rejected regardless of what the client rendered.
- All inbound WS traffic is hostile input (rule 1): validate at the edge, re-validate in the engine, count violations as risk signals (`../02-domains/risk.md`).
- Per-socket outbound backpressure: past the send-buffer high watermark the socket is disconnected (resume covers it) rather than ballooning memory.

## 12. Reconnect storms

- **Client**: exponential backoff with **full jitter** — base 1 s, factor 2, cap 30 s, `sleep = rand(0, min(cap, base·2^n))`; reset on successful resume. Ticket mint and resume are both rate-limited per user, so a hot loop degrades gracefully instead of hammering.
- **Server shed policy**: under connection-acceptance pressure (mass reconnect after a deploy/instance kill), the gateway sheds by refusing handshakes early with a retry-after hint rather than accepting-then-collapsing; resume is deliberately cheap (Redis range read). WAF absorbs volumetric noise. P14 load tests reconnect storms explicitly; shed thresholds are tuned there, not guessed here.
