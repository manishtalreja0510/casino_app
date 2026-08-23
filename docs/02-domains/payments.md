# Domain: Payments (`payments` module)

Phase: orchestration + fake PSP **pre-P15** (state machines testable on `TST`), real adapter **P17**, blocked on **P15 / OQ-02** (blocked on OQ-01). ADR: **ADR-014** (PROPOSED until OQ-02). Rules 8, 9, 11 govern. Related: `./wallet.md` (ledger), `./kyc-verification.md` (gates), `../06-compliance/`.

Purpose: PSP-agnostic orchestration of money crossing the platform boundary — deposits in, withdrawals out — as durable state machines in PG that translate verified external events into ledger transactions. The PSP is an adapter; the money logic is ours and provider-independent.

## 1. Design stance

**Problem.** Gambling is a high-risk merchant category; the realistic PSP set is unknown until the license exists (OQ-01→OQ-02), and multi-PSP is likely eventually — but deposit/withdrawal correctness, webhook discipline, and reconciliation shape the wallet and admin domains now.
**Approach:** `PaymentProviderPort` + orchestration state machines in PG, built and tested against a **fake PSP** on test currency pre-P15. Ledger-first accounting: platform money state changes only via wallet transactions, and only on *verified* external evidence.
**Alternatives:** integrate a mainstream PSP now (rejected: Stripe/Adyen-standard exclude gambling; wasted work), defer domain entirely to P17 (rejected: withdrawal holds and pending-state accounts must exist in the ledger design from P4; retrofit risk). **Trade-off:** port shaped before any real vendor — expect adapter-driven amendments at P17 (recorded in ADR-014 when accepted).

## 2. `PaymentProviderPort` (sketch)

```ts
interface PaymentProviderPort {
  createDepositIntent(req: {
    paymentId: string;                 // our UUIDv7 = idempotency scope
    userId: string; amount: bigint; currency: string;
    method?: string; returnUrl: string;
  }): Promise<{ providerRef: string; clientFlow: RedirectUrl | SdkParams; expiresAt: Date }>;

  verifyWebhook(raw: RawHttpRequest): Promise<{
    providerEventId: string;           // idempotency key
    providerRef: string;
    kind: 'deposit_completed' | 'deposit_failed' | 'payout_paid' | 'payout_failed'
        | 'payout_returned' | 'chargeback_opened' | 'chargeback_resolved' | ...;
    amount: bigint; currency: string; occurredAt: Date; raw: unknown;
  }>;                                   // throws on bad signature — nothing parsed further

  initiatePayout(req: { paymentId; userId; amount; currency; destinationRef }): Promise<{ providerRef }>;
  fetchStatement(range: { from: Date; to: Date }): Promise<StatementLine[]>;   // reconciliation feed
}
```

PSP selection criteria recorded in OQ-02: license acceptance, payout API, **signed webhooks**, statement/settlement-file API — a vendor missing any of these doesn't fit the port.

## 3. Owned data (tables)

| Table | Key contents |
|---|---|
| `payments` | id (UUIDv7), user_id, direction (deposit/withdrawal), state, amount, currency, provider, provider_ref, method, fees, created_at, state history refs, ledger_tx refs |
| `payment_events` | provider_event_id (unique — idempotency), payment_id, kind, payload hash, received_at, processed_at |
| `payment_methods` | user_id, provider token/ref, type, masked display, status — **provider tokens only, never PANs** (§9) |
| `payment_review_queue` | payment_id, trigger (threshold/risk/kyc/velocity), assignee, resolution, notes |
| `psp_statements` / `psp_statement_lines` | imported statements + match status per line (§7) |

Ledger account types added for this domain (in wallet, written only via wallet services): `psp_clearing` (per provider+currency: money the PSP owes/holds), `pending_withdrawal` (per currency: user funds held for in-flight payouts).

## 4. Deposit state machine

```
initiated ──(intent created @ PSP)──▶ pending ──verified webhook: completed──▶ completed
    │                                   │ └─▶ failed
    └────────(intent creation fails)──▶ failed        pending ──(TTL, no event)──▶ expired
completed ──chargeback_opened──▶ disputed ──resolved──▶ completed | charged_back
```

- **Ledger credit happens only on the verified `deposit_completed` webhook** — never on client return-URL redirect (client says nothing the server believes; the redirect only triggers a status poll for UX). Credit tx: `psp_clearing −a` / `user +a`, idempotency key `deposit:{paymentId}`.
- **Idempotent by `provider_event_id`** (unique insert in `payment_events`; duplicates ⇒ 200 no-op). Out-of-order events resolved by the state machine; an event for a terminal payment is logged + flagged if contradictory.
- Amount/currency in the webhook must equal the intent's exactly; mismatch ⇒ `payment_review_queue` + page, no credit.
- `expired`: intent TTL passes with no event; a late completion webhook after expiry goes to manual review (money may exist at PSP — human decides credit vs refund; never auto-dropped).

## 5. Withdrawal state machine

```
requested ─▶ checking (KYC level ≥ config, RG not blocking, risk check, limits/velocity)
   ├─ fail ─▶ rejected (reason to user; funds never left user account)
   └─ pass ─┬─ amount/risk ≥ threshold ─▶ manual_review ─▶ approved | rejected
            └─ else ────────────────────▶ approved
approved ─▶ processing (payout initiated @ PSP) ─▶ paid | failed | returned
```

- **Ledger-first hold:** on `requested` passing `checking` → tx `user −a` / `pending_withdrawal +a` (key `wd-hold:{paymentId}`). The user cannot re-spend money that's leaving. On `paid` (verified webhook): `pending_withdrawal −a` / `psp_clearing +a`. On `rejected`/`failed`/`returned`: reversal of the hold back to the user (audited; user notified).
- Gates: KYC level per jurisdiction config (`./kyc-verification.md`), payout-name/destination checks, self-excluded users **can** withdraw (`./authentication.md` §7), frozen users cannot (risk hold parks the request).
- **Manual review** above config thresholds (amount, cumulative velocity, risk score): finance role in admin (P12/P17 screens), four-eyes above a second threshold, SLA timers, every decision audited.
- `returned` (payout bounced after `paid`): PSP return event → reversal from `psp_clearing` back through `pending_withdrawal` to user + review-queue entry (destination problem or fraud probe — risk signal).

## 6. Chargebacks / returns

Deposit `disputed`: immediate risk hold on the account (configurable: freeze withdrawals always; gameplay per policy), funds clawback modeled as reversal `user −a` / `psp_clearing +a` **when the chargeback finalizes against us** (`charged_back`) — if the user already spent/withdrew, the user account CHECK would break, so clawback posts against a `chargeback_loss` house expense account for the shortfall (candidate account type, finalize in P17 planning), and the account is frozen pending investigation. Dispute evidence submission is manual via PSP console at v1. All dispute states feed risk (chargeback count = strong fraud signal) and AML review where thresholds apply.

## 7. Reconciliation (PSP ↔ ledger)

Scheduled `fetchStatement` import → match every statement line to a `payments` row + its ledger transactions (by provider_ref, amount, currency, date window). Classes of mismatch: statement-line-without-payment, payment-without-statement-line (after settlement lag window), amount/fee mismatch. **Any mismatch: page + freeze the affected payment(s)/scope; never silently adjusted** (rule 9) — resolution is a human-approved reversal/adjustment with incident record. Fees per line are posted to a `psp_fees` expense account so `psp_clearing` reconciles to cash. This job is the money-boundary counterpart of wallet's internal sweeps (`./wallet.md` §5).

## 8. Fees, limits, multi-PSP

- **Fees:** config per provider/method (fixed + bps); shown to user pre-confirmation; posted as separate ledger entries (never netted invisibly).
- **Limits:** min/max per transaction, daily/weekly/monthly per user — the *floor* is jurisdiction config (OQ-01) ∧ KYC level ∧ RG self-set limits (RG limits always win when stricter).
- **Multi-PSP readiness:** `provider` column everywhere, port per provider, `psp_clearing` per provider; a `PaymentRouter` (choose provider by method/currency/user geo/health) is a named seam, **not built** until a second PSP exists. Payment method tokens are provider-scoped (no portability assumed).

## 9. Security notes

- **No card data ever touches our servers.** Redirect or provider-SDK flows only; we store provider tokens + masked display. Target **SAQ-A** PCI posture; any vendor requiring more is rejected at OQ-02 evaluation.
- Webhooks: **signature verification before parsing** (rule 8), timestamp tolerance, endpoint IP-allowlist where the PSP supports it, replay-safe via event-id idempotency. Secrets from the secret manager (OQ-06), rotated per runbook.
- Payout destinations: bind-on-first-use + re-verification on change (new destination + immediate large withdrawal = review trigger).
- Every state transition audited; deposit/withdrawal REST endpoints are in the signed-request class (`./authentication.md` §4).
- Entire domain sits behind `compliance.real_money_enabled` (rule 11): pre-P18, only the fake provider on TST can ever execute.

## 10. Pre-P15 vs post-P15 build split

| Pre-P15 (buildable after P4) | Post-P15 (P17) |
|---|---|
| `PaymentProviderPort` in `packages/contracts` | Real PSP adapter(s) per OQ-02 |
| Deposit/withdrawal state machines, tables, ledger integration on TST | Sandbox e2e, all edges incl. chargebacks |
| **Fake PSP** (deterministic outcomes, signed fake webhooks, fake statements) | Statement reconciliation against real files |
| Review-queue model, limits/fees config keys | Finance admin screens, real thresholds from jurisdiction config |
| Reconciliation job skeleton | `compliance.real_money_enabled` still OFF through P17 — ON only at P18 |

## 11. Phase mapping & open questions

- **P17** scope/acceptance: `../MASTER_ROADMAP.md`. Depends on P15 (OQ-02 decided, contracts signed), P16 (KYC gates live).
- OQs touched: **OQ-01** (limits, AML thresholds, permitted methods), **OQ-02** (vendor + port validation), **OQ-08** (currencies/rails; crypto not recommended pre-license), **OQ-06** (webhook secrets).
- Candidate OQ: chargeback-shortfall accounting (`chargeback_loss` account) and dispute-evidence tooling depth — finalize in P17 planning; noted for consistency pass.
