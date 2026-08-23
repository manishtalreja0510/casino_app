# ADR-005: Redis responsibilities & limits

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

Real-time gameplay, matchmaking, rate limiting, and horizontal WS scaling need sub-millisecond shared state that PostgreSQL should not serve on every tick. But any fast store will attract data that belongs in PG; without an explicit line, "temporarily in Redis" becomes financial truth in a store designed to lose data.

## Decision

**Redis 7+ is disposable operational infrastructure.** Its full responsibility list:

| Use | Notes |
|---|---|
| Cache | sessions, feature flags (short TTL), lobby views |
| Distributed locks | Redlock-style on single instance; **fencing via PG** (versions/row locks) wherever correctness matters |
| Matchmaking queues, seat reservations | audit trail of matches stays in PG |
| Rate limiting | token buckets per IP/user/device/endpoint |
| Ephemeral game state | hot state + per-room replay ring buffer (~2 min) |
| Socket.IO adapter | `@socket.io/redis-adapter` for horizontal WS |
| BullMQ | job queues; state machines live in PG, jobs only drive transitions |

**Redis NEVER holds financial truth** (rule 7 ⛔). **Loss semantics — designed for, not hoped against:** everything in Redis is rebuildable. Redis loss may drop live connections and in-tick state; recovery loads the latest `game_snapshot` + replays `game_events` from PG (ADR-009); clients resync via full `playerView`. Unrecoverable in-flight hands are voided + refunded by reversal, audit-logged. No money is ever lost or corrupted by Redis loss.

**Topology:** single managed instance per environment at start; path to managed HA (replica + automatic failover) when connection counts or blast radius justify it. No Redis Cluster until key-space or throughput demands it.

## Alternatives considered

- **Redis as primary game-state store** (PG only for money). Faster to build, but disputes and crash recovery would depend on a store with weak durability, and "just this state too" scope-creeps toward money. The PG event log must remain the truth games are judged by. Rejected.
- **Kafka (or similar broker) for queues/events.** Serious operational footprint, and its strengths (replayable firehose, many consumers) solve problems we don't have. BullMQ on Redis covers retries/delayed jobs/DLQs; PG state machines carry correctness. Revisit only if extraction (ADR-003) creates real cross-service event needs. Rejected for now.
- **In-process cache only, no Redis.** Fails immediately: horizontal WS needs a shared adapter, rate limits and matchmaking queues must be shared across nodes, and BullMQ needs Redis anyway. Rejected.

## Consequences

**Positive:** one fast shared store serving six concerns; PG offloaded from per-tick traffic; horizontal scaling of WS and workers works from day one; Redis failure is an availability incident, never a correctness incident.

**Negative (accepted):** dual-write discipline — game code appends to PG events and updates Redis hot state, and the PG side must always win; the rebuild-from-PG path is real code that must be tested (chaos drills in P14); Redlock on a single instance is not a correctness primitive, hence mandatory PG fencing where it matters; single instance is a shared availability SPOF until managed HA.

## Links

- [system-architecture.md §5](../01-architecture/system-architecture.md), [realtime-architecture.md](../01-architecture/realtime-architecture.md), [game-architecture.md](../01-architecture/game-architecture.md)
- [system-rules.md](../00-project/system-rules.md) rule 7; ADR-004, ADR-007, ADR-009
- Phases: P1 (wiring), P5 (adapter/ring buffer), P6 (recovery), P14 (chaos drills)
