# ADR-008: Double-entry financial ledger

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

Money movement (deposits, buy-ins, settlements, rake, withdrawals, refunds) must be provably correct under concurrency, replayable for audit and disputes, and safe against retried requests. A mutable balance column cannot answer "where did this money come from", cannot prove conservation, and silently absorbs bugs.

## Decision

A **double-entry, append-only ledger in PostgreSQL** ([database-architecture.md](../01-architecture/database-architecture.md), [wallet.md](../02-domains/wallet.md)):

- `ledger_transactions` (unique `idempotency_key`, type, refs) + `ledger_entries` (account, signed BIGINT amount, currency) with **entries per transaction summing to zero — enforced**, over `accounts` (user wallet per currency; house accounts: `house_main`, `rake`, `bonus`; **escrow per match** `match_escrow`).
- **Balances are a cached derivation** (`balances`: version, `CHECK >= 0` for user accounts), updated in the same DB transaction under `SELECT ... FOR UPDATE` with ordered lock acquisition.
- **No UPDATE/DELETE on ledger tables** (revoked privileges + trigger guard). **Corrections are reversal transactions only.**
- Every mutating op: idempotency key, single DB transaction, concurrency-safe. READ COMMITTED + explicit row locks; SERIALIZABLE where multi-account reconciliation-critical ops need it.
- Match flow: buy-in user→escrow; settlement escrow→winners + rake→house, idempotent by match id; **escrow zeroes at settlement** (invariant). Reconciliation jobs check sum-zero, balance==derived, escrow==open matches, later PSP statements; drift pages a human and freezes scope (rule 9).

## Alternatives considered

- **Single-balance UPDATE model** (`UPDATE balances SET amount = amount - x`). Minimal code, but no history of *why*, no conservation proof (a bug prints or burns money invisibly), retries double-spend without bolt-on idempotency, and regulators/auditors expect double-entry. Rejected outright.
- **Event-sourcing everything** (balances only ever derived at read, CQRS projections). Purest form, but read-path complexity and projection-lag pitfalls everywhere balances gate actions. Our design keeps the append-only source of truth *and* a transactionally-consistent cache — the useful 90% without projection machinery. Rejected.
- **External ledger service** (TigerBeetle, ledger SaaS). Real merits at massive scale, but splits financial truth out of the PG transaction that also holds game settlement state (ADR-004), adds an ops/vendor dependency, and TigerBeetle-class systems constrain schema flexibility we still need. Revisit only if ledger write volume outgrows PG. Rejected for now.

## Consequences

**Positive:** conservation is checkable (everything sums to zero, forever); complete answerable history per account and match; idempotency makes client/webhook/job retries safe; reversal-only correction preserves the audit trail through every mistake; escrow accounts make match liability explicit and reconcilable.

**Negative (accepted):** **write amplification** — one logical op writes transaction + ≥2 entries + balance rows in one PG transaction (partitioning per ADR-004 when volume demands); **join complexity** — history and reporting queries traverse transactions↔entries↔accounts, needing careful indexing and read replicas later; ordered-lock discipline and idempotency plumbing on every financial code path is real, permanent developer overhead; hot house accounts (rake) serialize on their row lock under load.

## Links

- [database-architecture.md](../01-architecture/database-architecture.md), [wallet.md](../02-domains/wallet.md)
- [system-rules.md](../00-project/system-rules.md) rules 4–6, 9, 10 ⛔; ADR-004, ADR-009 (settlement), ADR-020 (raw SQL on ledger paths)
- Phases: P4 (build), P6 (settlement rails), P17 (PSP reconciliation)
