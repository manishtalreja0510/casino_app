# Domain: Wallet & Ledger (`wallet` module)

Phase: **P4** (on `TST` test credits). ADR: **ADR-008** (double-entry ledger), ADR-004 (PG as truth), ADR-020 (raw SQL for ledger-critical paths). Rules 4–10 (⛔) govern this module. Schema detail: `../01-architecture/database-architecture.md`.

Purpose: the **only** owner of money state. Every balance anyone ever sees derives from the append-only double-entry ledger here. Games settle *through* the engine into this module (rule 10); payments (P17) post here; nothing else writes financial state, and no client ever computes a balance.

## 1. Ledger design

**Problem.** Concurrent gameplay + payments must never lose, create, or double-count money; every unit must be explainable forever; corrections must be visible, not destructive.
**Approach (canonical, ADR-008):** classic double-entry, append-only, in PostgreSQL:

- **`accounts`** — id (UUIDv7), type, owner ref, currency, status. Types:
  - `user_wallet` — one per (user, currency); launch: `TST` only.
  - `house_main` — house float per currency (faucet source, house-banked game counterparty).
  - `rake` — house revenue from pooled games (poker rake).
  - `bonus` — promotional pool (schema-ready; product rules later phase).
  - `match_escrow` — **one per match**, opened at match creation, must read zero after settlement.
  - (P17 adds `psp_clearing` / `pending_withdrawal` — see `./payments.md`.)
- **`ledger_transactions`** — id, **idempotency_key (unique)**, type (enum: faucet, buy_in, settlement, rake, reversal, admin_adjustment, closure_forfeit, …), ref fields (match_id, payment_id, reversed_tx_id), created_at, created_by (service principal), metadata (jsonb, no PII). The unit of atomicity and the idempotency scope.
- **`ledger_entries`** — id, transaction_id, account_id, **amount BIGINT signed** (minor units), currency. **Sum of amounts per (transaction, currency) = 0** — enforced by deferred constraint trigger at commit. ≥2 entries per transaction.
- **`balances`** — account_id, balance BIGINT, **version** (monotonic), updated_at, `CHECK (balance >= 0)` for user accounts (house accounts may run negative float by design). A **cache inside the truth boundary**: updated in the *same DB transaction* as the entries, under `SELECT … FOR UPDATE` row locks acquired in **canonical order (account_id ascending)** to prevent deadlock. Version supports optimistic reads and drift detection.

**Append-only enforcement:** UPDATE/DELETE privileges revoked on `ledger_transactions`/`ledger_entries` for the app role + BEFORE trigger raising on any mutation (defense in depth). Corrections are **reversal transactions** referencing the original (rule 5).

**Alternatives considered:** single-row balance updates with a log (rejected: log becomes advisory, drift undetectable); event-sourcing balances from game events (rejected: money truth must not depend on game-domain replay); storing balances only derived-on-read (rejected: per-request `SUM()` cost; the cached row with same-tx update gives read speed *and* derivability). **Trade-offs:** hot house accounts serialize on their balance row — acceptable at target scale; if it burns, split house accounts into shards summed on read (documented escape hatch, not built).

## 2. Operation catalog (exposed domain services)

All operations: **idempotency key required**, **single DB transaction**, ordered row locks, audit event, READ COMMITTED + explicit locks (SERIALIZABLE reserved for multi-account reconciliation-critical ops where locking is insufficient — rule/brief). Replay with same key ⇒ return original result, no-op (verified by property tests, P4).

| Operation | Entries (per currency) | Notes |
|---|---|---|
| `grantFaucet(userId, amount)` | house_main −a / user +a | **TST only**, per-user rate + daily cap + lifetime cap (config); velocity-abuse signal → risk (P10). Exists so dev/staging economy runs without payments; disabled for real currencies permanently |
| `buyIn(matchId, userId, amount)` | user −a / match_escrow +a | idempotency key `buyin:{matchId}:{userId}[:{seq}]` (seq for poker top-ups); fails cleanly on insufficient funds (CHECK is backstop, precheck is UX); called by game-engine/matchmaking flows only |
| `settle(matchId, instructions[])` | match_escrow −Σ / winners +w… / rake +r | **single transaction for the whole match**, idempotent by `settle:{matchId}`; instructions come from `GameDefinition.settle()` via engine (ADR-009); validates Σ(instructions) == escrow balance exactly, else reject + page (never partial-settle). Escrow account must be 0 after — asserted in-tx |
| `reverse(txId, reason)` | mirror-image entries of original | the only "correction"; refs original; used for void-hand refunds (P6 crash recovery), admin corrections, payment returns (P17); reversing a reversal is rejected |
| `adminAdjustment(accountId, amount, reason)` | house_main ∓ / target ± | **four-eyes**: proposer + approver (distinct admin principals, P12; CLI with two-key flow pre-P12), threshold-free (always four-eyes), reason mandatory, audit both actors; implemented as its own tx type, reversible like everything |

P17 adds `postDeposit` / `holdWithdrawal` / `releaseWithdrawal` (see `./payments.md` — same discipline, new account types). Games/engine call `buyIn`/`settle`/`reverse` **only via the exported wallet domain service** — no other module touches these tables (rules 10, 20).

## 3. Invariants (tested + reconciled)

1. ∀ transaction, currency: Σ(entries.amount) = 0 (constraint + reconciliation).
2. ∀ user_wallet account: balance ≥ 0 at all times (CHECK + lock discipline).
3. ∀ settled/voided match: its `match_escrow` balance = 0; ∀ open match: escrow = Σ(buy-ins − mid-match refunds).
4. `balances.balance` ≡ Σ(entries for account) — always derivable, drift = incident.
5. Ledger tables are append-only; every correction is a linked reversal.
6. No transaction mixes currencies (single-currency entries per transaction — §6).
7. Every transaction carries a unique idempotency key; replays are no-ops.

## 4. Concurrency strategy

- One DB transaction per operation; lock **all touched balance rows** upfront via `SELECT … FOR UPDATE` in account_id order; insert transaction + entries; update balances (+version); commit. No gap where entries exist without balance update.
- Idempotency: insert `ledger_transactions` first; unique-violation on idempotency_key ⇒ fetch + return prior result.
- Redis is never consulted for balance truth (rule 7); distributed locks (Redlock) may reduce contention upstream (e.g. matchmaking) but correctness rests on PG row locks + constraints alone (fencing via PG versions).
- Isolation: READ COMMITTED + explicit locks for all catalog ops; SERIALIZABLE (with retry loop) for reconciliation sweeps and any future multi-account op where lock ordering can't be proven.

## 5. Reconciliation & drift response

BullMQ scheduled jobs (idempotent, rule 9), from P4:
1. **sum-zero sweep** — every transaction's entries sum to 0 per currency (should be impossible; verifies constraint integrity after migrations/restores).
2. **balance-derivation check** — `balances` vs Σ(entries), incremental by version watermark.
3. **escrow-vs-matches** — every non-zero `match_escrow` maps to an open match (joins engine's match state via its exported read service); settled/voided matches have zero escrow.
4. (P17) **PSP statement matching** — `./payments.md` §7.

**Any drift: page a human + freeze the affected scope** (single account → account freeze via risk; systemic → `wallet.freeze_all` kill-switch stopping all wallet ops). **Never silent auto-fix** (rule 9): the correction, once diagnosed, is a human-approved reversal/adjustment with an incident record. Runbook: `../07-operations/runbooks.md`.

## 6. Multi-currency stance

`currency` code on accounts/entries from day one; launch currency **`TST`** (test credits) only; real fiat currencies added at **P18** per **OQ-08** (crypto not recommended pre-license). **No cross-currency entries within one transaction** — FX, if ever, is two single-currency transactions linked by ref + an explicit fx-spread house account (design deferred; candidate ADR when OQ-08 resolves). `TST` and real currencies never mix in any entry set; `compliance.real_money_enabled` (rule 11) gates creation of non-TST user accounts entirely.

## 7. Transaction history API

The wallet exposes raw, complete per-account entry history internally; the **user-facing activity feed is a separate read model** — grouping, refs, pagination, export live in `./transactions.md`. Read-your-writes guarantee: any API response completing a wallet op returns the new balance + version from the same DB transaction; subsequent reads at ≥ that version (see `./transactions.md` §5).

## 8. Failure / edge cases

- Crash mid-operation: single-tx design ⇒ all-or-nothing; retried job/request hits idempotency key. Property/crash tests in P4 acceptance (`../../docs/MASTER_ROADMAP.md` P4).
- Settlement instructions ≠ escrow (engine bug): reject whole settlement, match stays `settling`, page — money never conjured to make a game happy.
- Insufficient funds race (two buy-ins, one balance): second locker fails precheck inside tx; CHECK constraint is the last line.
- Negative-amount / zero-entry submissions: rejected at service boundary (amounts nonzero, signs encode direction).
- Account frozen (risk): all catalog ops except incoming settlement/reversal refused (winnings still land; nothing leaves).

## 9. Explicit non-goals

- **No client-side balance math** — the app renders server-provided balances only (rule 21); optimistic UI may gray out spent amounts but never displays arithmetic it did itself as truth.
- **Games never call the ledger directly** — engine-mediated settlement only (rule 10).
- No bonuses/promotions logic in P4 (account type reserved), no fees engine (P17), no interest/holding logic, no multi-currency conversion.

## 10. Phase mapping & open questions

- **P4:** everything above on TST; admin CLI adjustments (four-eyes flow) pre-admin-panel. **P6:** engine settlement integration. **P12:** admin UI for adjustments/reconciliation dashboard. **P17:** payment account types + PSP reconciliation. **P18:** real-currency accounts behind the compliance gate.
- OQs touched: **OQ-08** (real currencies/FX), **OQ-01** (retention of financial records), **OQ-02** (PSP clearing model shapes P17 account additions).
