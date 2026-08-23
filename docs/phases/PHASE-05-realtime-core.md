# Phase 05 — Real-time core

## 1. Phase overview
The Socket.IO layer every game rides on: authenticated connections, rooms, a sequenced event protocol with resume, and server-authoritative timers. Roadmap: `../MASTER_ROADMAP.md` §P5.

## 2. Current status
`COMPLETE` — 2026-08-23.

## 3. Objective
A client can connect with a short-lived ticket, join a room, lose its connection mid-stream, reconnect to a **different server instance**, and resume without missing or double-applying a single event.

## 4. Dependencies
P3 (token model, sessions) and P1 (Redis, flags, audit) — COMPLETE.

## 5. Preconditions
Local Redis running; auth endpoints available for ticket issue.

## 6. Existing-code analysis
P3's `TokenService` and session store give the identity a ticket is minted from; P1's Redis client is reused for the adapter and the replay buffer. No parallel auth path is introduced — a WS ticket is derived from an authenticated REST call.

## 7. Scope
1. **Socket.IO gateway** with the Redis adapter for horizontal scale.
2. **Ticket auth** — `POST /realtime/ticket` issues a single-use, ~30 s, session- and device-bound ticket; the handshake exchanges it.
3. **Rooms** — `user:{userId}`, `match:{matchId}`; join/leave with membership authorisation.
4. **Event envelope** — versioned, per-room monotonic `seq`, server timestamp.
5. **Resume protocol** — a Redis ring buffer per room; `resume(room, lastSeq)` replays the gap or instructs a full resync when the gap is too large.
6. **Presence** — per-room membership tracked in Redis, surviving instance restarts.
7. **Server timers** — authoritative deadlines with a callback registry; client timers stay cosmetic.
8. **WS rate limiting and payload validation** — per-connection budgets, size caps.
9. **Flutter realtime client** — connect, resume, backoff, exposed as a stream.

## 8. Out of scope
Game logic and per-game events (P6+), matchmaking (P7), notifications (P11), horizontal load testing (P14).

## 9. Architecture considerations
Implements `../01-architecture/realtime-architecture.md` and ADR-007. Redis holds only ephemeral state (replay buffer, presence): losing it interrupts play but never money (rule 7, ADR-005). The authoritative record of a match is PostgreSQL, written by the engine in P6.

## 10. Database changes
None. Deliberate: the realtime layer is stateless and disposable — anything durable belongs to the engine.

## 11. Backend changes
`realtime` module: gateway, ticket service, room registry, sequencer + replay buffer, presence, timer service.

## 12. Flutter changes
`RealtimeClient` in `api_client` (socket connect, envelope decode, resume, backoff), plus a connection-state provider.

## 13. API changes
`POST /realtime/ticket` (authenticated).

## 14. WebSocket changes
The whole phase. Namespace `/game`; client→server `room:join`, `room:leave`, `resume`; server→client `room:joined`, `room:event`, `resume:complete`, `resync:required`, `error`.

## 15. Security considerations (MANDATORY)
- **Tickets, not tokens, on the wire.** A ticket is single-use, short-lived, and bound to the session and device that requested it; it is consumed atomically in Redis so two connections cannot share one.
- **The connection re-validates identity on every join**: session revoked mid-connection means the next room join fails and the socket is disconnected. A revoked session cannot keep playing because it already holds a socket.
- **Room membership is authorised server-side.** A client asking to join a room it has no claim on is refused — never "the client wouldn't do that" (rule 1).
- **Replay windows leak nothing**: buffered events are the ones already sent to that room, and per-recipient filtering (`playerView`) lands with the engine in P6, which is where hidden information first exists.
- **Payload caps and per-connection rate limits** bound the damage a hostile client can do; oversized or malformed frames disconnect.
- **Timers are server-side only** (rule 2). The client is told a deadline for display; expiry is decided by the server.
- Checklist §A, plus §C items that apply pre-engine.

## 16. Edge cases
Ticket replayed, expired, or used from another device; two connections for one user; server instance killed mid-match; Redis flush (presence and buffer lost); `lastSeq` older than the buffer; `lastSeq` ahead of the server (client rollback); duplicate delivery; slow consumer; clock skew on displayed deadlines.

## 17. Testing strategy
Integration with real Redis and two gateway instances: connect with a ticket, reject a replayed ticket, deliver events in order, resume across a simulated disconnect **on a second instance**, force a resync when the gap exceeds the buffer, and prove a revoked session cannot join.

## 18. Implementation plan
Ticket service → sequencer/buffer → gateway → presence → timers → tests → Flutter client → verify.

## 19. Rollback / recovery
No schema, no persistent state — revert the commit. Redis keys are namespaced `rt:` and disposable.

## 20. Acceptance criteria
1. A valid ticket connects; a replayed or expired one is refused.
2. Events carry a monotonic per-room `seq` and arrive in order.
3. A client that misses events resumes from `lastSeq` and receives exactly the gap.
4. A gap larger than the buffer yields `resync:required`, not silent loss.
5. Resume works against a **different instance** than the one that sent the original events.
6. A revoked session cannot join a room.
7. `pnpm verify:all` green.

## 21. Definition of done
As previous phases, plus the two-instance resume test passing.

## 22. Completion report

**Delivered as planned.** All 9 scope items: the `/game` gateway with the Redis adapter, single-use tickets, room authorisation, the sequenced envelope, the resume protocol with a ring buffer, presence, server-authoritative timers, payload/rate bounds, and the Flutter realtime client.

**Three real bugs, all found by the two-instance integration test.**

1. **The Redis adapter was never attached.** `server.adapter is not a function` — a namespaced gateway receives the **Namespace** in `afterInit`, not the Server. Fixed by reaching through `namespace.server`. Without this there is no horizontal scaling at all.

2. **Cross-instance delivery was silently broken.** The adapter's clients were `duplicate()`s of the application Redis client, which deliberately runs with `enableOfflineQueue: false` so ordinary traffic fails fast on a dead cache. The adapter issues its `SUBSCRIBE` immediately, while the connection is still opening, so the command was rejected — leaving the adapter unsubscribed **with nothing in the logs to say so**. Broadcasts simply never crossed instances. The adapter now gets dedicated clients with queueing enabled, and boot waits for both to be ready. This is the failure mode the two-instance test exists for: single-instance tests pass happily while the platform cannot scale.

3. **Authentication ran too late.** Rejecting in `handleConnection` means the handshake has already completed — the client sees a successful `connect` and is disconnected a moment later, so an unauthenticated socket briefly exists on the server. Authentication is now handshake middleware, so a rejected connection is never established and the client receives `connect_error`.

**A P1 issue fixed at its root.** The same Redis startup race that made readiness flap in P1 reappeared here as ticket issuance failing right after boot. Rather than patch a second consumer, `RedisModule` now waits (bounded, 5 s, non-fatal) for the connection during bootstrap. If Redis is genuinely down the app still starts degraded — flags fall back to PostgreSQL and readiness reports it (rule 7).

**The properties that matter are proven, not asserted.** Two independent Nest applications stand in for two instances behind a load balancer:
- A client connects to instance A, drops, and **resumes against instance B**, receiving exactly the two events it missed — which only works because sequence and buffer live in Redis, not in a process.
- A replayed ticket is refused (single-use, consumed with `GETDEL`).
- A client asking to join **another player's** user room is refused — the case the check exists for (rule 1).
- A session revoked mid-connection cannot join and is disconnected.
- A gap larger than the buffer, and a client reporting a sequence *ahead* of the server (the post-Redis-flush case), both yield an explicit `resync:required` rather than silent partial delivery.
- Timers fire, cancel, replace-on-reschedule, and survive a throwing handler.

**Test evidence.** 19 realtime integration tests green plus the existing suites; `pnpm verify:all` green across all 11 lanes.

## 23. Known limitations
- **Match-room authorisation is permissive by design until P6.** Any authenticated user may join `match:*`; narrowing it to actual participants needs the match roster, which the engine owns. `canJoin()` is the single place that changes — but until P6 lands, room membership is not proof of participation.
- **No per-connection rate limiting yet.** Payload size is capped (32 KB) and rooms are validated, but a client can still emit frequently; the limiter exists (P1) and needs wiring per event class. Not exercised until real game actions exist.
- **Presence has no cross-instance cleanup on hard kill** beyond its 60 s TTL, so a killed instance leaves entries for up to a minute.
- **Resume replays room-wide events.** Per-recipient filtering (`playerView`) is P6's responsibility, and hidden information does not exist yet — but the buffer must become per-recipient before poker, or a resume could hand a player events meant for the room.
- **The Flutter realtime client is unit-tested only against its own logic**; there is no device-level socket test, and reconnect/backoff is driven by the app rather than the socket library because tickets are single-use.
- **Load characteristics are unknown** — connection counts, buffer memory, and adapter throughput are P14's business.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Replay buffer is room-wide, not per recipient | Must change before hidden information exists | P6, before poker (P9) |
| No per-event rate limiting on the socket | A chatty client is unbounded | P6/P7, when real actions exist |
| Presence TTL is the only ghost cleanup | Stale entries for up to 60 s after a hard kill | P14 |
| Ring buffer size is a constant, not per-room config | A very busy table could outrun 512 events | P9/P14, measured |
| Flutter client lacks an integration test against a live gateway | Client resume logic is unproven end to end | P7, with the first real screen |

## 25. Next-phase dependencies
P6 broadcasts `playerView` through this layer and schedules turn deadlines with the timer service.
