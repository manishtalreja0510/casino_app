# ADR-007: WebSocket strategy (Socket.IO)

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

Gameplay needs low-latency bidirectional messaging with rooms, reconnection, ordered delivery, and horizontal scale across API nodes. Mobile networks drop constantly, so resume-without-data-loss is a first-class requirement, and whatever we pick must integrate with NestJS and have a solid Dart client.

## Decision

**Socket.IO, WebSocket transport primary**, with **`@socket.io/redis-adapter`** for cross-node fan-out. REST handles everything non-realtime. Per [realtime-architecture.md](../01-architecture/realtime-architecture.md):

- Namespaces `/lobby` and `/game`; rooms `user:{userId}`, `table:{tableId}`/`match:{matchId}`.
- Auth: short-lived one-time WS ticket via REST, exchanged at handshake; connection bound to session + device (ADR-013).
- Versioned event envelope; every server event carries per-room `seq`; client acks; reconnect = auth + `resume(matchId, lastSeq)` → replay from the Redis ring buffer (~2 min window) or full `playerView` resync.
- Sticky sessions at the LB only for the polling fallback; prefer WS-only.

## Alternatives considered

- **Raw `ws` + hand-rolled protocol.** Lowest overhead and full control, but we would rebuild rooms, namespaces, heartbeats, cross-node adapter, reconnection, and fallback — thousands of lines of protocol plumbing with money on top, plus a from-scratch Dart client. Our seq/resume layer is custom either way; the plumbing needn't be. Rejected.
- **Centrifugo / managed realtime (Ably, Pusher-class).** Operationally attractive, but game reducers need to *react* to client messages inline with engine state — an external broker splits the hot path across a network hop and another trust boundary, and managed vendors put a third party inside real-money game traffic (and gambling ToS questions). Rejected.
- **gRPC bidirectional streams.** Strong typing, but weak browser story (hurts admin/spectator options), immature Dart-mobile streaming ergonomics for this use, and no room/fan-out layer — we'd rebuild the adapter anyway. Rejected.

## Consequences

**Positive:** rooms, heartbeats, reconnection, multiplexed namespaces, and horizontal fan-out are maintained commodity code; first-class NestJS gateway integration; usable Dart client; polling fallback exists for hostile networks even if disprefered.

**Negative (accepted):** Socket.IO adds protocol overhead (its own framing/handshake on top of WS) and its guarantees are at-most-once without our ack/seq layer — the seq/resume protocol is *our* correctness mechanism, Socket.IO is just transport; the Redis adapter broadcasts across all nodes and offers no per-room backpressure. **Revisit trigger:** when concurrent connections or per-node room counts make adapter fan-out or Redis pub/sub the measured bottleneck (P14 load tests set the baseline), evaluate sharded adapters, a dedicated WS tier (extraction per ADR-003), or replacing Socket.IO at the edge — the versioned envelope + seq/resume protocol is transport-agnostic by design so clients survive that swap.

## Links

- [realtime-architecture.md](../01-architecture/realtime-architecture.md), [websocket-conventions.md](../03-api/websocket-conventions.md)
- ADR-003 (role flags/extraction), ADR-005 (adapter + ring buffer), ADR-006 (server authority), ADR-013 (WS tickets)
- Phases: P5 (realtime core), P14 (load limits)
