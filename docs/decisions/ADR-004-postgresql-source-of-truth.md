# ADR-004: PostgreSQL as sole source of truth

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

A real-money platform's data layer must make disputes, audits, and reconciliation answerable from one place, with transactional guarantees strong enough for a double-entry ledger. Splitting truth across stores multiplies failure modes: every additional "source of truth" is another consistency boundary to reconcile and another way to lose money.

## Decision

**PostgreSQL 16+ is the single source of truth for ALL persistent and financial data**: ledger, balances, users/sessions/devices, KYC/payment state machines, game events + snapshots, matchmaking audit trail, feature flags, and the hash-chained audit log. Everything else (Redis, caches, client state) is a disposable derivation.

Design implications this locks in:

- **Ledger** (ADR-008): append-only tables, zero-sum constraint per transaction, cached `balances` updated in the same DB transaction under ordered row locks. READ COMMITTED + explicit locking by default; SERIALIZABLE for reconciliation-critical multi-account ops.
- **Game truth**: append-only `game_events` + periodic `game_snapshots` in PG; Redis hot state is an optimization, recovery and disputes replay from PG ([game-architecture.md](../01-architecture/game-architecture.md)).
- **Audit**: append-only, hash-chained table; UPDATE/DELETE revoked + trigger-guarded.
- Money as BIGINT minor units + currency code; UUIDv7 ids; timestamptz UTC ([database-architecture.md](../01-architecture/database-architecture.md)).

**Scaling path** (in order, each a config/topology change): connection pooling (PgBouncer-class) → read replicas for history/lobby/reporting reads → partitioning of high-volume append-only tables (`game_events`, `ledger_entries`, audit) by time → per-module schema separation easing later extraction (ADR-003). Sharding is out of scope until evidence demands it.

## Alternatives considered

- **Polyglot persistence** (PG for money + Mongo/Cassandra for game events, etc.). Two operational surfaces, two backup/restore stories, and cross-store consistency exactly where disputes live (game outcome ↔ settlement). Rejected; PG handles our append-only event volumes fine with partitioning.
- **Event-store products** (EventStoreDB/Kafka-as-log) for game/ledger history. Adds a system of record outside PG, splitting truth and complicating the "settlement is one transaction" property. Our event-sourcing needs are narrow (game log) and PG-append-only covers them. Rejected.
- **NoSQL primary** (DynamoDB/Mongo). Weak multi-row transactional semantics relative to what a zero-sum ledger + escrow flow demands; conditional-write gymnastics to emulate constraints PG gives declaratively. Rejected outright for financial truth.

## Consequences

**Positive:** one backup/restore/PITR story; declarative integrity (constraints, triggers, revoked privileges) enforcing money rules at the datastore; single-transaction settlements; every dispute answerable by SQL over one database.

**Negative (accepted):** PG is the scaling bottleneck by design — we accept doing replica/partitioning work when growth demands it rather than pre-sharding; write-heavy append-only tables need vacuum/bloat and index attention; the single primary is a critical SPOF requiring managed HA (automatic failover, tested restores) from the first real-money phase.

## Links

- [database-architecture.md](../01-architecture/database-architecture.md), [system-architecture.md §5](../01-architecture/system-architecture.md)
- [system-rules.md](../00-project/system-rules.md) rules 4–7; ADR-005 (Redis limits), ADR-008 (ledger), ADR-020 (data access)
- Phases: P1 (wiring/migrations), P4 (ledger), P6 (game event log)
