# ADR-020: Data Access Layer

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

PostgreSQL is the sole source of truth (ADR-004) and the ledger demands exact SQL semantics: explicit ordered row locks, `SELECT … FOR UPDATE`, CTEs, constraint-enforced invariants (rules 4–6). We need TypeScript type safety for the 90% CRUD surface without an abstraction that hides — or worse, rewrites — the SQL on the 10% where the SQL *is* the correctness argument. Migrations on a financial schema must be reviewable as SQL and safe to roll forward under load.

## Decision

- **Drizzle ORM** for schema definition and typed queries: SQL-transparent by design (queries map 1:1 to the SQL emitted), first-class raw-SQL escape hatch, TS-native schema as code.
- **SQL-first migrations:** `drizzle-kit generate` produces SQL files that are **hand-reviewed and hand-edited** before merge — the SQL file is the artifact of record, not the generator output. Every migration ships forward SQL **plus a documented rollback** (a tested down-script, or an explicit "roll-forward-only" note with rationale for destructive steps). **Zero-downtime rules:** additive first; `NOT NULL`/constraint additions staged (add nullable → backfill → validate constraint `NOT VALID`→`VALIDATE`); no long-lock DDL on hot tables; index creation `CONCURRENTLY`.
- **Raw SQL mandated for ledger-critical paths** — ledger transactions, balance updates, escrow settlement, reconciliation: explicit locking order, CTEs, and isolation choices written out and reviewed as SQL (per ADR-008). Drizzle's `sql` template keeps these typed at the edges; no query builder abstracts them.
- **Repository layer per module:** each NestJS module's repositories are the only code touching its tables (rule 20); services never import Drizzle directly. This is also the seam for Testcontainers-backed integration tests (ADR-010).

## Alternatives considered

- **Prisma** — strongest DX, but weaker ergonomics for explicit locking (`FOR UPDATE` and lock ordering pushed into raw strings outside the type system) and a migration engine opaque enough that hand-shaping financial DDL fights the tool; rejected.
- **TypeORM** — long-standing maintenance and quality concerns, historically surprising behaviors on transactions/cascades — disqualifying near money; rejected.
- **MikroORM** — technically credible (UoW, good transactions) but a much smaller ecosystem/bus-factor for a system that will live on this ORM for years; rejected.
- **Kysely** — query-builder-only, excellent SQL transparency; close second. Loses on schema-as-code + migration generation, meaning more boilerplate for the large CRUD surface. Rejected narrowly; it remains the fallback if Drizzle disappoints.
- **Raw `pg` everywhere** — maximum control, but sacrifices type safety across hundreds of ordinary CRUD queries where typos become runtime bugs; rejected.

## Consequences

- One mental model: what Drizzle emits is what runs; ledger SQL is visible in review exactly as it executes.
- Hand-reviewed SQL migrations cost time per schema change; on a financial schema that review *is* the safety mechanism, not overhead.
- Drizzle is younger than Prisma/TypeORM — API churn risk accepted; the repository layer confines any future swap.
- Two idioms (typed builder + raw SQL) coexist; the rule for which applies is bright-line: touching ledger/escrow/balance rows ⇒ raw SQL.
- Optional pgTAP-style constraint tests can assert DB-level invariants (append-only triggers, zero-sum checks) independently of app code.

## Links

- ../01-architecture/database-architecture.md, ../01-architecture/backend-architecture.md, ../02-domains/wallet.md
- ../00-project/system-rules.md (rules 4–6, 20), ADR-004 (PG source of truth), ADR-008 (ledger), ADR-010 (testing)
- Phases: P1, P4
