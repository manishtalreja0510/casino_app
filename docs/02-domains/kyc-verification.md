# Domain: KYC / Identity Verification (`kyc` module)

Phase: port + state machine + fake provider **pre-P15** (buildable any time after P3; level *enforcement* wiring lands with the features it gates); real adapter **P16**, blocked on **P15 / OQ-03** (which is blocked on OQ-01). ADR: **ADR-015** (PROPOSED until OQ-03). Compliance detail: `../06-compliance/kyc-aml.md`, `../06-compliance/jurisdiction-matrix.md`.

Purpose: provider-agnostic identity verification — who a user legally is, whether they're of age, and what limits apply — without coupling the platform to any vendor before counsel picks one (rule 24: we abstract, we don't guess).

## 1. Design stance

**Problem.** KYC provider and required depth are functions of the license (OQ-01/03), undecided until P15 — but level gating, state handling, and webhook plumbing shape wallet, payments, RG, and admin *now*.
**Approach:** hexagonal port. All orchestration, state, level policy, and enforcement are ours and jurisdiction-configurable; the vendor is an adapter behind `KycProviderPort`, exercised pre-P15 by a deterministic **fake provider**.
**Alternatives:** pick a likely vendor early (rejected: vendor choice is license-dependent; sunk integration + possible rebuild); defer the whole domain to P16 (rejected: level model is load-bearing for wallet limits, RG age verification, and withdrawal gating — retrofit cost too high).
**Trade-off:** the port may need extension for a real vendor's quirks (extra redirect legs, SDK tokens) — accepted; extension points are noted below.

## 2. `KycProviderPort` (sketch)

```ts
interface KycProviderPort {
  // Create a provider-side verification case for a user at a target level.
  // Returns what the client needs to run the provider flow (URL or SDK token).
  startVerification(req: {
    userId: string; caseId: string;            // our UUIDv7s; caseId = idempotency scope
    targetLevel: 'L1' | 'L2';
    jurisdictionConfig: KycRequirementSet;      // doc types, liveness, address proof...
    locale: string;
  }): Promise<{ providerRef: string; clientFlow: RedirectUrl | SdkToken }>;

  // Normalize + verify an inbound webhook. MUST verify signature before parsing.
  handleWebhook(raw: RawHttpRequest): Promise<{
    providerEventId: string;                    // idempotency key
    providerRef: string;
    verdict: 'approved' | 'rejected' | 'review' | 'expired' | 'error';
    reasonCodes: string[];
    extracted?: MinimalVerifiedFields;          // dob, name, doc country — nothing more
  }>;

  getStatus(providerRef: string): Promise<ProviderCaseStatus>;   // poll fallback / reconcile
  requestReVerification(req: { userId; caseId; reason: 'expiry'|'doc_change'|'risk' }): Promise<...>;
}
```

Extension points reserved: multi-step flows (provider callbacks mid-flow), document re-upload on soft reject, PEP/sanctions screening results if the vendor bundles them (fed to `risk`, not stored here beyond a flag).

## 3. Level model

| Level | Meaning | Grants (jurisdiction-configurable — values below are pre-P15 defaults) |
|---|---|---|
| **L0** | unverified | test currency (`TST`) only; play allowed in dev/staging product; **no real-money capability of any kind**; minimal PII held |
| **L1** | identity + age verified (doc + liveness or DB check per config) | real-money deposits/play up to per-level limits; withdrawals up to threshold |
| **L2** | enhanced (address proof, source-of-funds where required) | higher/unbounded limits per license; required above AML thresholds |

Requirements *and* limit values per level come from the jurisdiction config matrix (filled at P15, OQ-01); code references config keys, never literals. Level is monotonic per user (no downgrade except `expired` → re-verification required, which suspends the level's grants without deleting history). Age verification for RG (rule 12) is satisfied at L1 — RG treats "age_verified" as a derived predicate of level ≥ L1.

## 4. Owned data (tables)

| Table | Key contents |
|---|---|
| `kyc_cases` | id (caseId, UUIDv7), user_id, target_level, state (§5), provider (nullable pre-P16 / 'fake'), provider_ref, attempt_count, created_at, decided_at, reason_codes |
| `kyc_webhook_events` | provider_event_id (unique — idempotency), case_id, raw payload hash, received_at, processed_at, outcome |
| `kyc_levels` | user_id, level (L0/L1/L2), achieved_at, expires_at (config), source_case_id — current level is the max non-expired row |
| `kyc_review_queue` | case_id, enqueued_at, assignee, resolution, notes — manual-review branch (§5), surfaced in admin (P12/P16) |

Verified PII fields (dob, legal name) are **not** stored here — they're written to `users.user_pii` (encrypted) via the users service (`./users.md` §4). This module stores process state and verdicts.

## 5. Verification state machine (per case)

```
none ──start──▶ pending ──provider verdict──▶ verified
                  │  │                          ▲
                  │  ├─▶ rejected ──retry (≤N)──┘ (new case, attempt_count++)
                  │  ├─▶ manual_review ──admin──▶ verified | rejected
                  │  └─▶ expired (provider/case timeout) ──restart──▶ pending
                  └─(provider error / abandoned, TTL)──▶ expired
verified ──(document/level expiry per config)──▶ expired → re-verification case
```

- One active (non-terminal) case per user per target level (partial unique index).
- `rejected` with retryable reason codes (blurry doc, mismatch) allows ≤N attempts (config) then forces `manual_review`; non-retryable codes (underage, sanctions hit) go straight to `manual_review` + risk signal, never silent retry.
- All transitions append to case history + audit log; `kyc.level_changed` domain event consumed by wallet (limits), RG (age), payments (withdrawal gate), risk.

## 6. Webhooks: idempotency + signature

Rule 8 applies verbatim: **signature-verified before any parse/state change** (adapter-specific scheme: HMAC or asymmetric per vendor; fake provider uses HMAC with a test secret), then **idempotent by `provider_event_id`** (unique insert into `kyc_webhook_events`; duplicate ⇒ 200 + no-op). Out-of-order events resolved by case state machine (a verdict for an already-terminal case is logged + ignored, flagged if contradictory). Processing is transactional: event row + case transition + level grant in one DB tx; side effects (notifications, domain events) after commit via outbox/BullMQ.

## 7. PII minimization

Prefer **provider-side document storage** (a vendor-selection criterion in OQ-03): we hold `provider_ref`, verdict, reason codes, and only the minimal fields the platform needs (dob for age/RG, legal name for payout-name matching at P17, document country for geo cross-check at P18) — encrypted at rest in `user_pii`. Raw document images never transit our storage; if a chosen vendor forces doc custody on us, that's an ADR-015 amendment with its own storage/retention design, not a silent change. Retention of verdicts/fields per jurisdiction config (OQ-01); erasure follows `./users.md` §6 (crypto-shred + legal holds).

## 8. Admin manual-review queue

P12 admin panel gains KYC screens at P16: queue (age of case, reason codes, provider deep-link to review UI — reviewers look at documents *in the provider's console*, keeping images off our systems), approve/reject with mandatory reason, escalation to compliance role, SLA timers. Every decision: four-eyes above configured sensitivity (e.g. overturning a sanctions-related rejection), full audit trail, decision reason codes feed risk.

## 9. Failure modes

- **Provider outage:** `startVerification` failures → case stays `none`/`pending` with retry/backoff (BullMQ); users see "verification temporarily unavailable". **Degrade honestly: verification never silently passes** — no fallback-to-approved, ever. Existing verified users unaffected; new real-money onboarding pauses. Kill-switch: `kyc.provider_enabled` per provider.
- **Webhook silence:** scheduled `getStatus` reconcile for cases pending > threshold; mismatch between poll and our state → flag + manual review, never auto-overwrite a terminal state.
- **Contradictory verdicts** (webhook approved after poll-rejected): freeze case to `manual_review`, page compliance, audit both payloads (hashes).
- **User abandons flow:** case TTL → `expired`; restart allowed; abandonment count is a risk signal.

## 10. Pre-P15 vs post-P15 build split

| Pre-P15 (buildable now) | Post-P15 (P16) |
|---|---|
| `KycProviderPort` interface in `packages/contracts` | Real adapter for chosen vendor (OQ-03) |
| Case state machine, tables, level model + config keys | Jurisdiction requirement/limit values (from matrix) |
| **Fake provider** (deterministic verdicts by test-input convention, signed fake webhooks) for integration tests + staging | Sandbox e2e all verdict paths |
| Level-gate enforcement points wired (wallet limits, RG age predicate, withdrawal gate stubs) | Enforcement live with real limits |
| Review-queue model | Admin KYC screens, reviewer SLAs |

## 11. Phase mapping & open questions

- **P15** decides OQ-03 (with OQ-01) → ADR-015 to ACCEPTED. **P16** builds the adapter + flows + admin screens. **P17** consumes level gates for withdrawals. **P18** uses doc-country in geo cross-checks.
- OQs touched: **OQ-01** (depth, documents, retention, thresholds), **OQ-03** (vendor, storage custody, screening bundling), **OQ-06** (encryption keys for mirrored fields).
