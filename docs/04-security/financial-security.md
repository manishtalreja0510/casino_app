# Financial Security

Attack/defense view of the money system. The ledger *design* is `../02-domains/wallet.md` and ADR-008; database enforcement detail is `../01-architecture/database-architecture.md`; this doc maps attacks to controls and states what evidence each phase must produce. Threat rows: `./threat-model.md` TB1/TB3, ranks 1–3. Rules 4–10 (⛔) are assumed throughout.

## 1. Ledger recap (defense baseline)

- **Integer minor units** (`BIGINT` + currency code); floats/decimals forbidden everywhere (rule 4).
- **Double-entry, append-only:** `ledger_transactions` (unique `idempotency_key`) + `ledger_entries` summing to zero per transaction; `balances` as locked, versioned cache updated in the same DB tx; no UPDATE/DELETE on ledger tables — revoked privileges + trigger guard; corrections are **reversal transactions**.
- Why this is a *security* design, not just accounting: an attacker (or bug) cannot silently edit history — they can only add entries, and every addition must balance. Detection reduces to invariant checking (§10), and forensics always has the full record.

## 2. Attack surface map

| Attack | Controls | Evidence required |
|---|---|---|
| Replayed financial request | Idempotency keys (§3) + request signing nonce (`./authentication-security.md §4`) | replay tests per endpoint |
| Parallel-spend race | Ordered row locks + constraints (§4) | concurrency test suite (P4) |
| Webhook forgery/replay | Signatures + event-id idempotency (§5) | forgery/replay tests (P17) |
| Stolen-session withdrawal | Signing, re-auth, destination controls, velocity, review (§6) | flow tests (P17) |
| Faucet/bonus farming | Limits + velocity + device graphs (§8) | abuse-scenario tests (P10) |
| Insider adjustment fraud | Four-eyes, audit, DB privilege split (§9) | RBAC/privilege tests (P12) |
| Silent drift / logic bug | Reconciliation + invariant monitoring (§10) | injected-fault detection (P4/P17) |
| Currency confusion | Single-currency transactions, per-entry checks (§12) | constraint tests (P4) |

## 3. Idempotency as a security control

Every mutating financial endpoint requires an `Idempotency-Key` (unique in `ledger_transactions`). Security reading: **replay of a captured request — by an attacker, a flaky network, or a retrying client — is a no-op returning the original result.** Combined with the signing nonce (which rejects replays at the auth layer for signed endpoints), duplication of money by repetition is structurally impossible rather than policed. Keys are scoped per user+operation; a key collision with different payload is rejected (not silently returned) to block key-fixation games. Settlement is idempotent **by match id** (rule 10) — a crashed-and-retried settlement job cannot pay twice.

## 4. Concurrency attacks

Attack: fire N parallel buy-ins/withdrawals hoping two read the same balance before either writes (classic parallel-spend). Defenses, all mandatory:

- **Ordered row locks:** every multi-account transaction acquires `SELECT ... FOR UPDATE` on `balances` rows in a **globally consistent order** (account id sort) — no deadlock-and-retry ambiguity for attackers to time.
- **Non-negative constraint:** `CHECK (balance >= 0)` on user accounts — even a locking bug cannot commit an overdraw; the constraint is the last line, not the first.
- READ COMMITTED + explicit locks as default; **SERIALIZABLE** for reconciliation-critical multi-account operations where locking alone is insufficient (per brief/ADR-008).
- **Test evidence required (non-negotiable, P4 gate):** property/concurrency tests — parallel debit storms never overdraw; crash mid-transaction leaves ledger consistent; idempotent replays no-op. A phase touching money without this evidence fails `./security-checklist.md §B`.

## 5. Webhook forgery & replay (P17)

The PSP webhook path is an unauthenticated-in-principle ingress asserting "money arrived" — the highest-value forgery target (`./threat-model.md` rank 2). Defenses in order:

1. **Signature verification before anything** (rule 8) — provider scheme via `PaymentProviderPort` adapter; secret in the secret manager; timestamped signatures where the provider supports them (bounds replay of the raw HTTP request).
2. **Idempotency by provider event id** (unique constraint) — replays no-op.
3. **Network posture:** separate ingress path, provider IP allowlists where published (`./network-security.md §6`).
4. **Semantic validation:** event must match a known pending intent (our deposit state machine in PG); an event for an unknown/mismatched intent is quarantined + alerted, never credited.
5. **Reconciliation backstop (§10):** even a fully forged-but-verified event (compromised provider secret) surfaces as a PSP-statement mismatch.

## 6. Withdrawal attack surface (P17)

Withdrawals convert everything upstream (ATO, session theft, collusion winnings) into real loss — the choke point gets the heaviest controls:

| Control | Defends against |
|---|---|
| KYC-verified accounts only (L-level per jurisdiction config) | anonymous cash-out, AML exposure |
| Request signing + fresh re-auth on withdrawal initiation | stolen bearer/refresh token cash-out from another device |
| **Payout-destination changes: re-auth + notification + cooling-off delay before first use** | ATO adding their own destination and draining |
| Payout **only to verified/owned destinations where the rails allow** (name-match / closed-loop back to deposit source preferred) | mule destinations |
| Velocity limits (amount + count per hour/day, per account and destination) | fast drain before detection |
| **Threshold-based manual review queue** + risk-score gating | large/anomalous cash-outs; review before money moves |
| Ledger-first pending states (funds moved to a payout-pending account before PSP call) | double-spend of "in-flight" funds |
| Kill-switch scope: withdrawals independently freezable | active incident containment |

## 7. Deposit-side posture

Deliberately lighter than withdrawals (money flows in): controls are §3 idempotency + §5 webhook verification plus AML/KYT thresholds on aggregate deposit patterns (`../02-domains/fraud-risk.md §8`, jurisdiction config post-P15) and chargeback-state handling in the deposit state machine (`../02-domains/payments.md`). Deposits still emit velocity signals — card-testing patterns (many small failed deposits) are a fraud signature worth catching for the PSP relationship alone.

## 8. Faucet abuse (test currency)

`TST` faucet farming loses no real money, but it: pollutes gameplay/economy data, rehearses real bonus-abuse patterns, and identifies abuse infrastructure early. So the faucet is built with the same controls future promotions need: per-account/device/IP limits, velocity rules, risk-signal emission on farming patterns (`../02-domains/fraud-risk.md`). Treat faucet-abuse detection as the free training environment for P18-era bonus abuse.

## 9. Internal fraud

- **Four-eyes on manual adjustments** above threshold (and on `compliance.real_money_enabled`): initiator ≠ approver, enforced in the admin module, both identities audited (P12).
- Adjustments are **reversal-based only** — no operator, at any privilege, has an "edit balance" primitive.
- **Immutable audit:** hash-chained append-only log for every admin financial action (rule 15); chain verification job alerts on tamper.
- **Least-privilege DB roles:** the application role **cannot UPDATE/DELETE ledger rows** (revoked + trigger guard); admin/human roles have no direct prod DB write path at all (operations go through the audited admin module); migration role separate and CI-gated. A compromised app server can therefore append garbage (caught by §10) but cannot rewrite history.
- Support staff see money only through read-scoped RBAC screens with PII read-audit.

## 10. Reconciliation as detection

Reconciliation is the financial IDS, not bookkeeping hygiene (rule 9):

- Scheduled jobs: entries-sum-zero per transaction; `balances` == derived sums; escrow == open matches; (P17+) PSP statement matching.
- **Any drift pages a human and freezes the affected scope** (account, game, or payment rail — narrowest scope that contains the anomaly). Never auto-corrected, never silently logged: an unexplained cent is evidence of a bug or an attack until proven otherwise.
- Freeze scopes are pre-defined so the on-call decision is "which scope", not "what do we even freeze" (`../07-operations/runbooks.md`).

**Continuous invariant monitoring (production):** between full reconciliation runs, a lightweight sampler continuously re-verifies sum-zero on recent transactions and spot-checks balance derivations; alert thresholds: any hard invariant violation = page immediately; soft anomalies (rate spikes in reversals, settlement retries) = warn → review. Metrics land in the standard observability stack (OQ-10).

## 11. Float & rounding policy

- **No floats anywhere** in any money path — DB, backend, contracts, client display math (rule 4 ⛔). Display formatting divides integers at the last step; contracts carry integers + currency code.
- **Explicit integer rounding rules for every percentage-derived amount** (rake, fees, bonuses): each config declares its rule, and the default is **round in the house's disfavor** (rake rounds down, player-credit rounds up) — documented per config value so fairness disputes have a written answer and no code path improvises. Property tests pin the rule (e.g. total rake ≤ configured percentage across any pot partition, `../02-domains/poker.md`).
- Sum-zero must hold **after** rounding: rounding remainders are explicitly assigned (to the player side, per the rule above), never dropped.

## 12. Currency confusion defenses

- **No cross-currency transactions:** all entries in one ledger transaction share one currency (enforced by constraint/trigger). Conversion, if it ever exists, is two same-currency transactions linked by reference plus an explicit FX-account design — out of scope until an OQ opens it (OQ-08 governs real currencies).
- **Currency checked on every entry** against the account's currency (accounts are per-currency); mismatch = rejected transaction, alerted — this is a *bug or attack* signal, not a validation nicety.
- Launch runs `TST` only; the multi-currency schema exists so P18's real-currency accounts add rows, not migrations of meaning. `TST` and real currencies can never touch in one transaction by the same constraint.

## 13. Verification summary (what each phase must show)

| Phase | Evidence |
|---|---|
| P4 | Concurrency/property suite green; constraint tests (append-only, sum-zero, non-negative, currency-match); injected reconciliation fault detected in staging |
| P6 | Settlement idempotency by match id; escrow zeroes at settlement; void→reversal path audited |
| P10 | Faucet-abuse scenarios detected; velocity rules fire |
| P12 | Four-eyes enforced; RBAC matrix; DB-privilege tests (app role cannot UPDATE/DELETE ledger) |
| P17 | Webhook forgery/replay tests; withdrawal flow controls; PSP reconciliation catches injected mismatch |
| P14/P18 | Invariant monitoring live + alert drill; re-run of the above on final config |

All items appear as gates in `./security-checklist.md §B`.
