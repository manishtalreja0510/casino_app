# Phase 04 — Wallet & ledger (test currency)

## 1. Phase overview
The double-entry ledger and wallet domain, on `TST` test credits. Roadmap: `../MASTER_ROADMAP.md` §P4. This is the money core: everything from P6 settlement onward depends on its invariants holding under concurrency.

## 2. Current status
`COMPLETE` — 2026-08-23.

## 3. Objective
Money exists only as balanced, append-only, idempotent double-entry transactions; balances are a derived cache that provably matches the ledger; and reconciliation detects drift rather than trusting that it cannot happen.

## 4. Dependencies
P3 (authenticated principal, signed-request guard) and P1 (`withTransaction`, audit, flags) — COMPLETE.

## 5. Preconditions
Migrations 0001–0002 applied; local Postgres/Redis running.

## 6. Existing-code analysis
P1 gave `withTransaction` (with isolation levels) and an audit writer that joins the caller's transaction — both are prerequisites here. P3 gave `@SignedRequest()`, unused until now; funding endpoints are its first real users.

## 7. Scope
1. **Schema** (`wallet`): `accounts`, `ledger_transactions`, `ledger_entries`, `balances`, with zero-sum, append-only and non-negative enforcement in the database.
2. **Ledger service** — the only writer: `post()` takes balanced entries plus an idempotency key and commits atomically.
3. **Operations** — direct-credit funding (ADR-022), escrow buy-in, settlement, reversal, admin adjustment.
4. **Idempotency** — a unique key per transaction; a replay returns the original result rather than double-posting.
5. **Concurrency** — ordered row locks; parallel debits cannot overdraw.
6. **Balances cache** — updated in the same transaction as the entries, with a version column.
7. **Reconciliation job** — entries sum to zero per transaction, cached balances match derived sums, escrow accounts are empty when no match is open; drift alerts rather than self-heals.
8. **API** — balance, transaction history, direct-credit funding (flag-gated, signature-required).
9. **Flutter** — wallet screen: balance, history, add-funds.

## 8. Out of scope
PSP deposits/withdrawals (P17, parked), bonuses, multi-currency conversion, admin UI (P12), game settlement callers (P6 consumes the service).

## 9. Architecture considerations
Implements ADR-008 and `../02-domains/wallet.md`. Raw SQL for ledger paths (ADR-020) because explicit locking and constraint behaviour matter more than ORM ergonomics. `games/*` will never import this module — settlement goes engine → wallet (rule 10).

## 10. Database changes
Migration `0003_wallet.sql`: four tables; a deferred constraint trigger asserting entries sum to zero per transaction; append-only triggers on entries and transactions; `CHECK (balance >= 0)` on user accounts; unique idempotency key.

## 11. Backend changes
`wallet` module: `LedgerService` (posting primitive), `WalletService` (domain operations), `WalletRepository`, `ReconciliationService` + job, controller.

## 12. Flutter changes
`features/wallet`: balance card, transaction list, add-funds sheet; wallet providers.

## 13. API changes
`GET /wallet/balance`, `GET /wallet/transactions`, `POST /wallet/funding` (flag-gated, `@SignedRequest()`).

## 14. WebSocket changes
None (P5).

## 15. Security considerations (MANDATORY)
- **Rules 4–6 are the phase.** Integer minor units; append-only double entry; every mutation idempotent, atomic, concurrency-safe.
- **Database-enforced invariants, not application-enforced**: unbalanced transactions, ledger mutation, and negative user balances are all rejected by Postgres, so a bug in application code cannot corrupt money.
- **Direct-credit funding is gated twice** (ADR-022): the `payments.dev_direct_credit` flag must be on **and** `compliance.real_money_enabled` must be off. A test asserts the two can never both be satisfied.
- **Funding requires a device signature** — first use of P3's guard.
- **Every money movement is audited in the same transaction**; a rolled-back transfer leaves no audit claim that it happened.
- **Reconciliation pages rather than repairs** (rule 9): silent auto-correction would hide the bug that caused the drift.
- Checklist §A and §B in full.

## 16. Edge cases
Concurrent debits on one account; replayed idempotency key with a different payload; settlement of an already-settled match; reversal of a reversal; zero and negative amounts; currency mismatch; escrow left non-empty; balance row missing; crash between entry insert and balance update (impossible — same transaction, asserted by test).

## 17. Testing strategy
Property/concurrency tests against real Postgres: 50 parallel debits on one balance never overdraw and never lose an update; idempotent replay posts once; unbalanced posting rejected by the database; ledger UPDATE/DELETE rejected; reconciliation detects injected drift. Plus API-level tests for gating and signing.

## 18. Implementation plan
Migration → ledger primitive → wallet operations → reconciliation → controller → tests → Flutter → verify.

## 19. Rollback / recovery
`DROP SCHEMA wallet CASCADE` while no production data exists. After that, never — the ledger is append-only by design.

## 20. Acceptance criteria
1. An unbalanced transaction is rejected by the database, not by application code.
2. `UPDATE`/`DELETE` on ledger tables is rejected.
3. 50 concurrent debits against one balance leave it correct and non-negative.
4. A replayed idempotency key returns the original transaction without double-posting.
5. Cached balances equal the derived sum after every operation; reconciliation detects injected drift.
6. Direct-credit funding is refused when the flag is off or the compliance gate is on, and requires a valid signature.
7. `pnpm verify:all` green.

## 21. Definition of done
As P3, plus: reconciliation demonstrably catches a fault injected in a test.

## 22. Completion report

**Delivered as planned.** All 9 scope items: `wallet` schema with database-enforced invariants, the `LedgerService` posting primitive, wallet operations (funding, buy-in, settlement, reversal), idempotency, ordered-lock concurrency safety, the balance cache, the reconciliation service, the REST surface, and the Flutter wallet screen.

**Two real bugs, both found by tests, both in the money path.**

1. **Every debit from an existing account was being rejected.** The balance cache used `INSERT … ON CONFLICT DO UPDATE SET amount = amount + EXCLUDED.amount`, but PostgreSQL fires `BEFORE INSERT` triggers *before* it detects the conflict — so the non-negative guard saw the raw delta (`-1000`) rather than the resulting balance, and raised "insufficient funds" on every withdrawal. Fixed by seeding the row at zero and then updating, so the guard only ever evaluates a real balance.

   **My own test let this through first.** The 50-concurrent-debit test asserted `balance == 10_000 - succeeded * 300` and `succeeded <= 33` — both of which hold when `succeeded` is zero. It passed while nothing worked. The test now asserts `succeeded === 33` exactly: bounded on both sides, so it cannot pass vacuously. That weakness is worth more attention than the bug.

2. **A retried settlement was rejected.** Business validation ran before the idempotency check, so a replay found the escrow already emptied and threw "would pay 1000 from an escrow of 0". Idempotency now short-circuits first. This is precisely the crash-retry path P6's recovery depends on, so it would have surfaced later as a much more expensive bug.

**A secret-scan finding, investigated rather than waved through.** gitleaks flagged a P3 test placeholder — `'-----BEGIN PRIVATE KEY-----\n'.padEnd(140, 'x')`, PEM armour followed by literal x characters. It was a false positive, but the fix is that the placeholder no longer *looks* like a key, so nothing can mistake it again. The historical commit is pinned by **fingerprint**, deliberately not by allowlisting the `private-key` rule or that file: a genuine key committed there must still fail the scan.

**Invariants proven against a real PostgreSQL, not asserted in prose.** An unbalanced transaction is refused at commit by a deferred constraint trigger — tested by writing the rows directly, bypassing application validation entirely. `UPDATE`/`DELETE` on ledger tables is refused. A player balance cannot go negative. 50 concurrent buy-ins against one balance leave it exactly correct with no overdraw and no lost update. Replays post once — including eight concurrent replays of the same key. Settlement empties escrow, sweeps the remainder to rake, and pays once however often it is retried. Reversal posts a mirror image and leaves the original intact.

**The ADR-022 gate is enforced in the service, not by a flag default:** funding is refused whenever `compliance.real_money_enabled` is ON *even with its own flag ON*, and a test asserts exactly that. A money-creating path must be unreachable the moment real money is.

**Reconciliation detects, never repairs** (rule 9): the drift test corrupts the balance cache directly and asserts the report identifies the account and check. Auto-correction would destroy the evidence needed to find the cause.

**Test evidence.** 18 ledger integration tests, 33 other integration, 74 unit, 18 Flutter — all green, no skips. `pnpm verify:all` green across all 11 lanes.

## 23. Known limitations
- **Reconciliation is not scheduled.** The service and its checks exist and are tested; wiring it to BullMQ with a paging destination needs an alerting target, which arrives with observability work. Until then it is run manually or from a test.
- **Funding limits are per-request and per-24h only** — no velocity scoring or device-graph correlation; that is P10's risk engine, which consumes this data.
- **`house_dev_funding` has an unbounded negative balance by design** (it is the counterparty that mints test credits). Before P18 this account and the whole direct-credit path must be verified absent or disabled — recorded as an explicit launch-gate item in ADR-022.
- **No admin adjustment endpoint yet** — `WalletService.reverse()` exists and is tested, but four-eyes approval and the UI are P12.
- **Transaction history has no cursor pagination in the client** — the API accepts `before`, the Flutter screen fetches the first page only.
- **Settlement assumes a single currency per match**, which is correct today (`TST` only) and enforced by the ledger's no-cross-currency rule.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Reconciliation unscheduled and unpaged | Drift would be found late | With observability/alerting; before P14 |
| Balance read is a separate query after each write | Extra round trip on funding | Return the balance from the posting transaction when it matters |
| No partitioning on `ledger_entries` | Fine at current volume; planned trigger is ~100 GB | P14 or when volume demands |
| Reversal has no four-eyes enforcement | Relies on caller discipline until P12 | P12 |
| Funding cap constants are hardcoded | Should be config once RG limits exist | P10 |

## 25. Next-phase dependencies
P6 settles matches through `WalletService.settle()`, idempotent by match id. P12 gets reversal and adjustment operations to expose.
