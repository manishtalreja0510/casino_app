# ADR-015: KYC Provider Abstraction

**Status:** PROPOSED (blocked on OQ-03, which is blocked on OQ-01 — provider and verification depth follow the license)
**Date:** 2026-08-23

## Context

KYC depth (documents, liveness, database checks, PEP/sanctions screening) is dictated by the license (OQ-01), so no provider is choosable now (OQ-03). But KYC *levels* gate wallet limits, withdrawals, and responsible-gaming age verification — that level model shapes wallet, payments, and RG design today, and cannot wait for P16.

## Decision

- **`KycProviderPort`**: start verification (returns provider session/redirect handle), receive webhook result, trigger document re-check. Implemented per provider under `kyc`; nothing outside the module sees provider shapes.
- **Level model L0/L1/L2**, jurisdiction-configurable:
  - **L0** — no verification: test currency only, no real-money capability ever.
  - **L1** — basic identity (age + identity attestation per jurisdiction config): unlocks limited real-money play/deposits where the license allows.
  - **L2** — full verification (doc + liveness and/or database checks per jurisdiction): required for withdrawals and higher thresholds.
  - What each level *requires* and *unlocks* lives in the jurisdiction config matrix, not code (`docs/06-compliance/jurisdiction-matrix.md`).
- **Verification state machine in PG** (`none → pending → verified/rejected/expired`, per level) driven by signature-verified, idempotent webhooks (rule 8); manual-review path for provider "refer" outcomes.
- **Fake provider adapter** for all pre-P15 development: scripted verify/reject/refer/timeout outcomes so wallet/RG/withdrawal gating is fully testable on `TST`.
- **PII minimization:** documents and biometric artifacts stay **provider-side** wherever possible; we store verification status, level, provider reference id, and the minimal attributes the license mandates. No document images in our stores by default; no PII in logs (rule 15).

## Alternatives considered

- **In-house document verification** — rejected: forgery detection, liveness, and sanctions screening are specialist liability we should buy, not build; accuracy failures are regulatory failures.
- **Hard integration with one provider now** — rejected: provider is unquotable pre-license, and per-market document coverage varies; the port keeps P16 an adapter task.
- **Defer all KYC design until a provider is chosen** — rejected: the level model gates wallet limits, withdrawals, and RG age verification, which are built from P4/P10 — deferring would bolt compliance on later (violates rule 12's spirit).

## Consequences

- Wallet, payments, and RG code against stable levels now; P16 swaps the fake adapter for a real one plus jurisdiction config values.
- Provider-side PII storage minimizes our breach/DPA surface but creates provider dependency for audits — statement/export access becomes a provider selection criterion (OQ-03).
- Level semantics chosen now might not map 1:1 onto a future license's tiers; the jurisdiction config layer absorbs that, at the cost of config complexity.

## Links

- ../00-project/open-questions.md (OQ-01, OQ-03), ../02-domains/kyc-verification.md, ../02-domains/wallet.md, ../02-domains/responsible-gaming.md
- ../06-compliance/ (jurisdiction matrix, authored in compliance pass), ADR-014-payment-provider-abstraction.md
- Phases: P4, P10, P15, P16
