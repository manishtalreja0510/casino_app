# Domain: Transactions (user-facing history read model)

Phase: **P4** (with wallet; UI in P4 scope "transaction history API + UI"), extended at P17 (deposits/withdrawals) and P15 (retention/export policy). Lives in the `wallet` module as its read-model sub-surface (no separate write domain — it owns no financial truth). Related: `./wallet.md`, `./payments.md`, `../03-api/api-conventions.md`.

Purpose: translate the double-entry ledger — correct but unreadable to players ("5 entries across 3 accounts") — into the activity feed a user understands, with stable public references, pagination, filters, and export. Strictly a **projection**: it can always be rebuilt from the ledger; it never influences it.

## 1. "Transaction" to a user vs the ledger

A ledger transaction is a balanced multi-entry accounting fact. A **user activity item** is one user-comprehensible event derived from the ledger transactions touching that user's accounts:

| Activity type | Derived from (ledger tx types / entries) | Display amount |
|---|---|---|
| Deposit | `deposit` credit to user wallet (P17) | +a (+ fee shown separately) |
| Withdrawal | `wd-hold` + terminal outcome (paid/returned) collapsed into **one item with status** | −a |
| Buy-in | `buy_in` user→match_escrow, with match/game ref | −a |
| Winnings | user-credit leg of `settlement`, with match ref | +w |
| Rake | not a user item — rake is house-side; poker UI shows rake per hand via game history, not the money feed |
| Faucet | `faucet` credit (TST) | +a |
| Adjustment | `admin_adjustment` / user-visible `reversal` (e.g. void-hand refund shown as "refund — hand voided") | ±a |

Grouping rules: one activity item per (ledger transaction × user). Multi-step flows (withdrawal hold→paid) are **one item whose status advances**, keyed by the payment id, so users don't see internal hold mechanics. Losses need no item: a lost buy-in is simply a buy-in with no winnings item (match ref links to game history for the outcome). House-internal entries (escrow↔rake, clearing, fees accounts) never appear.

## 2. Data & consistency of the projection

Implementation: SQL views / query layer over `ledger_transactions` + `ledger_entries` (+ `payments` for status), plus a small `activity_refs` mapping table assigning each user-visible item its **public ref** (§4). No duplicated amounts stored — amounts always read from ledger entries, so the feed cannot disagree with the ledger (rebuildable-by-construction; a materialized cache may come later for scale, with the ledger remaining the source).

## 3. History API

`GET /api/v1/wallet/activity` — **cursor pagination** (opaque cursor encoding (created_at, id) per `../03-api/api-conventions.md`; no offsets), newest-first. Filters: `type[]`, `currency`, `from`/`to` (timestamptz), `matchId`, `status` (pending/completed/failed — payments). Item shape: `{ ref, type, status, amount, currency, balance_after?, created_at, match_ref?, payment_status?, display_key }` — `display_key` is a translation key + params (client renders localized text; server sends no prose). `GET /api/v1/wallet/activity/{ref}` for detail (entries summary in user terms, related refs, timestamps). `balance_after` is the user's wallet balance version after that transaction — computable because balance updates are same-tx with entries (`./wallet.md` §1).

## 4. Receipts & public references

**No internal ids leaked:** ledger transaction UUIDs, account ids, and PSP provider refs stay server-side. Each user-visible item gets a **public ref**: `TXN-{base32(shortened uuidv7)}-{check}` (~14 chars, uppercase, check digits catch typos in support conversations). Property: unguessable-enough is *not* the security boundary — access is always authenticated + owner-scoped; the ref is an identifier, not a capability. Refs are stable forever (support tickets, exports, disputes quote them) and stored in `activity_refs` (ref unique, → ledger_tx id + user id). Payments additionally expose the PSP's *user-facing* reference where the PSP provides one (what appears on a bank statement), clearly labeled.

## 5. Consistency guarantees

- **Read-your-writes for balance after action:** every mutating wallet/payment response includes `{balance, version}` from the committing transaction; the client renders that immediately (no client math — rule 21). Subsequent `GET` reads carry the version; if a replica/cache serves an older version, the API falls through to primary. Practically at launch (single primary): reads are current by default; the version contract is what keeps this true when replicas arrive.
- Activity list is eventually consistent within the same request-response bounds (it reads the same PG); a completed action always appears in the next list fetch.
- Feed order is by ledger commit time; refs are the tie-breaker; cursors are stable under concurrent inserts (no skipped/duplicated items across pages).

## 6. Export & retention

- **CSV/statement export:** async job (BullMQ), owner-requested from the app or admin-requested for support/compliance; date-ranged; columns: ref, type, status, amount, currency, balance_after, timestamps, match/payment public refs. Delivered via authenticated download, link expiry, generation audited. Doubles as the data-subject-export financial section (`./users.md` §6).
- **Retention:** ledger truth is retained per financial/AML law (durations = jurisdiction config, **OQ-01**, set at P15); the read model inherits it (projection of retained data). After account erasure, activity remains queryable only by compliance role against the pseudonymized user id (`./users.md` §6); public refs remain valid for the retention window (dispute handling).

## 7. Relationship to the audit log

Different consumers, different guarantees — deliberately **separate tables, separate domains**:

| | `transactions` (this read model) | `audit` domain |
|---|---|---|
| Audience | the user (and support on their behalf) | security/compliance review, incident forensics |
| Content | user-comprehensible money activity only | every sensitive action: money, auth, admin, game voids, flag changes (rule 15) |
| Source | projection over ledger (rebuildable, no independent truth) | independent append-only, **hash-chained** table written at action time |
| Guarantees | consistency with ledger by construction; presentation may evolve freely | tamper-evidence, completeness, immutability; format stable |
| Mutability | views/refs can be re-derived, re-grouped, re-labeled | never rewritten, ever |

A money event therefore appears in *three* places with three jobs: ledger (accounting truth), audit log (tamper-evident record that it happened, with actor), activity feed (user presentation). None substitutes for another.

## 8. Failure / edge cases

- Ledger tx types added later (P17) without feed mapping: unmapped types render as generic "adjustment" with correct amount rather than being hidden — the feed must never silently omit money movement; CI check keeps the type→display mapping total.
- Reversal display: original item stays, gains `reversed` status + link; the reversal is its own item — history never rewrites (mirrors ledger semantics).
- Pending deposit expired at PSP after user paid (late-completion review, `./payments.md` §4): item shows `pending → under review` honestly rather than failed.
- Timezones: API returns UTC timestamptz only; client localizes (brief rule).

## 9. Phase mapping & open questions

- **P4:** feed + history API + refs + UI on TST types (faucet, buy-in, winnings, adjustments). **P12:** admin views reuse the same read model (plus internal detail joins gated by role). **P17:** deposit/withdrawal items + PSP refs + export hardening. **P15:** retention values, export/statement compliance formatting.
- OQs touched: **OQ-01** (retention durations, statement/reporting formats), **OQ-02** (PSP user-facing references), **OQ-08** (multi-currency display).
