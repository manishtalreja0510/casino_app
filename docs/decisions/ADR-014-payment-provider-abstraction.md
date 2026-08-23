# ADR-014: Payment Provider Abstraction

**Status:** PROPOSED (blocked on OQ-02, which is blocked on OQ-01 — no PSP is selectable before jurisdiction/license)
**Date:** 2026-08-23

## Context

No PSP can be chosen today: gambling is a high-risk merchant category, realistic PSPs are gambling specialists, and every one of them quotes against a license we don't have (OQ-01 → OQ-02). Yet deposits/withdrawals shape the wallet, ledger, risk, and admin domains now, and P17 must be an adapter task, not a redesign. Multi-PSP (redundancy, per-market methods) is likely eventually.

## Decision

- **`PaymentProviderPort`** — the only surface any PSP touches: create deposit intent, verify/parse webhook, initiate payout, fetch statement/settlement files. Defined in `packages/contracts`-adjacent backend types; implemented per provider under `payments`.
- **Orchestration state machines in PG** own deposit and withdrawal lifecycles (`created → pending → confirmed/failed → reconciled`, withdrawal adds KYC/risk/manual-review gates). Providers only trigger transitions; state is never provider-side truth.
- **Ledger-first accounting** (ADR-008): every money movement is a double-entry ledger transaction; PSP events post idempotent ledger transactions, never balance edits.
- **Webhooks:** signature-verified, idempotent by provider event id (unique constraint), processed through the state machines (rule 8).
- **Fake-PSP adapter** implements the port for all pre-P15 development and testing (test currency `TST`): scripted successes, failures, delays, duplicate webhooks, chargebacks. The entire payments domain is built and load/chaos-tested against it.
- **Multi-PSP readiness:** provider routing keyed by (jurisdiction, method, currency); provider id recorded on every transaction; reconciliation per provider statement.

## Alternatives considered

- **Direct single-PSP integration now** — rejected: no PSP is selectable pre-license, and coupling orchestration to one provider's shapes is exactly the rework P17 must avoid.
- **Payment orchestration SaaS** (routing/cascading platforms) — plausibly valuable for multi-PSP cascading; deferred as an explicit evaluation option at P15 — it would sit *behind* the same port.
- **Crypto rails** — rejected pre-license: AML burden, PSP/banking conflicts, prohibited in several candidate regimes (OQ-08).

## Consequences

- P17 becomes: implement one port adapter + map real webhook signatures + reconcile real statements. Orchestration, ledger, risk hooks, and admin review queues are already proven on the fake adapter.
- Cost: the port must stay honest — any leak of provider-specific shapes into orchestration re-couples us. Reviewed at each payments change.
- The fake adapter must be pessimistic (duplicates, out-of-order, late webhooks) or it trains false confidence.
- Real PSP behaviors we can't foresee (settlement quirks, partial refunds) may still force port evolution at P17; accepted.

## Links

- ../00-project/open-questions.md (OQ-01, OQ-02, OQ-08), ../02-domains/payments.md, ../02-domains/wallet.md
- ../00-project/system-rules.md (rules 8, 11), ADR-008 (ledger), ADR-015-kyc-provider-abstraction.md
- Phases: P4, P15, P17
