# ADR-003: NestJS modular monolith

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

The backend must cover many domains (auth, wallet, payments, game engine, per-game modules, matchmaking, realtime, risk, RG, notifications, audit, admin, platform, jobs) with a small team, strict correctness requirements on money paths, and unknown eventual scale. Distributed-system complexity (network partitions, cross-service transactions over a ledger) would be actively dangerous now; a boundary-free monolith would rot into a ball of mud we can never split.

## Decision

One **NestJS + TypeScript modular monolith** (`apps/api`, Node 22 LTS), single deployable scaled horizontally, with hard internal boundaries:

- **Module per domain**, per the canonical module map in [system-architecture.md](../01-architecture/system-architecture.md) / [backend-architecture.md](../01-architecture/backend-architecture.md).
- **Module-owned tables** (rule 20): a module touches only its own tables. Cross-module interaction only via **exported services** (sync) and **in-process domain events** (async). Games never touch wallet/ledger directly (rule 10) — settlement flows game-engine → wallet service.
- **Extraction-ready seams:** service interfaces + domain events + owned tables are the future service boundaries; extraction is a deployment change, not a rewrite.
- **Role flags:** the same image can run as API node, WS node, or BullMQ worker via env-selected roles — process topology can change without code change.

**Extraction triggers** (revisit this ADR when any fires): a module's load profile diverges hard from the rest (likely first: realtime+game-engine CPU/connection load, or risk's batch analytics); a module needs independent deploy cadence or scaling that role flags can't express; team growth demands independent ownership; PG contention traced to one module's workload requiring its own datastore topology.

## Alternatives considered

- **Microservices now.** Cross-service consistency over a double-entry ledger means sagas/outboxes on day one, per-service infra, and distributed debugging — massive cost for zero current benefit, against rule 22. Rejected.
- **Unstructured monolith** ("just build features"). Fastest for a month; then shared tables and tangled imports make both correctness review and later extraction impossible. The boundaries are cheap now and priceless later. Rejected.

## Consequences

**Positive:** one deploy, one transaction boundary (a settlement is a single PG transaction), simple local dev, in-process events with no broker to operate; NestJS DI/module system gives us enforceable boundaries and testable seams; clear later path to services.

**Negative (accepted):** boundary discipline is enforced by convention, lint, and review — the runtime won't stop an illegal import; in-process domain events are lost on crash (anything that must survive goes through PG state machines + BullMQ, not fire-and-forget events); one bad module can degrade the whole process until extracted; NestJS decorator/DI magic has a learning curve and some runtime indirection.

## Links

- [backend-architecture.md](../01-architecture/backend-architecture.md), [system-architecture.md §8](../01-architecture/system-architecture.md)
- [system-rules.md](../00-project/system-rules.md) rules 10, 19, 20, 22
- ADR-004 (PG), ADR-005 (Redis), ADR-007 (WS scaling), ADR-009 (game contract)
- Phases: P1 (chassis), P3+ (domain modules)
