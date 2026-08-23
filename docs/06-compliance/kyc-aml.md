# KYC / AML — Provider-Agnostic Requirements

> Planning-grade; **verify with counsel — not legal advice.** Concrete values (thresholds, documents, retention) come from `jurisdiction-matrix.md` §3 at **P15** (OQ-01) and the vendor choice at OQ-03. This doc fixes the *shape* every plausible license requires, so P16/P17 are integration, not redesign. Mechanism/domain detail: `../02-domains/kyc-verification.md` (port, state machine, level model), `../02-domains/fraud-risk.md` (KYT hooks).

## 1. KYC level model vs regime classes

Levels are ours (L0/L1/L2, `../02-domains/kyc-verification.md` §3); regimes map onto them via config, they don't reshape them.

| Level | Grants | Typical strict regime (UK-class) | Typical mid regime (MGA/IoM-class) | Typical light regime (Curaçao-class) |
|---|---|---|---|---|
| **L0** — unverified | `TST` test currency only; no real-money capability | Not sufficient for any gambling; some regimes gate even free play (`rg.age_gate_free_play`) | Not sufficient for real money | Not sufficient for real money under LOK |
| **L1** — identity + age | Real-money play/deposits up to per-level limits; withdrawals to threshold | Required **before first deposit/play**; doc + liveness or strong DB check | Required before withdrawal, with deposit-side verification deadlines | Required, lighter evidence accepted |
| **L2** — enhanced (address, SOF where required) | Higher/unbounded limits; mandatory above AML thresholds | Triggered by affordability/risk, not only amount | Triggered at EDD threshold (~€2k-class cumulative) or risk flags | Triggered at higher thresholds / risk flags |

Rules that hold in every regime: verification never silently passes on provider failure; level is monotonic (expiry → re-verify, no silent downgrade); L0 = the entire pre-P15 product.

## 2. Document types matrix (superset; per-regime subset via `kyc.accepted_documents`)

| Purpose | Document classes | Notes |
|---|---|---|
| Identity + age (L1) | Passport, national ID card, driving licence | Liveness/selfie match per `kyc.liveness_required`; DB-check alternative where regime accepts |
| Address (L2) | Utility bill, bank statement, government letter (recency window config) | Some regimes accept DB checks |
| Source of funds (L2/threshold) | Payslips, bank statements, tax returns, sale/inheritance evidence | Free-text + doc upload → manual review queue, never auto-approved |
| Payment instrument ownership (P17) | Card/account matching name check | PSP-side where possible (OQ-02 criterion) |

## 3. AML program elements (needed under every plausible license)

| Element | Requirement shape | Engineering hook |
|---|---|---|
| AML policy + MLRO-equivalent officer | Business/counsel deliverable (OQ-11) | Admin role `compliance` (P12 RBAC) with report/queue access |
| Business risk assessment | Documented, reviewed annually | Input to risk-engine rule weights (`../02-domains/fraud-risk.md`) |
| Customer due diligence (CDD/EDD) | L1 = CDD; L2 = EDD; thresholds per `aml.edd_threshold` | KYC level enforcement at wallet/payments gates |
| KYT / transaction monitoring | Ongoing monitoring of deposits, withdrawals, gameplay flows for structuring, layering, minimal-play pass-through | Risk engine ingests every ledger-affecting event; velocity + pattern rules with `aml.*` threshold config (built P10, values P15) |
| Sanctions + PEP screening | At onboarding and periodically re-screened | Vendor-bundled with KYC where possible (OQ-03 criterion); result = risk flag + manual review, never silent |
| SAR/STR-style reporting readiness | File suspicious-activity reports to the regime's FIU in its format/deadline | Case model in review queue: evidence bundle export (ledger slice, game events, session/device history) — no auto-filing; humans file. **No tipping-off**: user-facing states stay generic (“under review”) |
| Threshold reporting (where regime has it, e.g. FINTRAC CA$10k-class) | Automatic report generation above `aml.report_thresholds` | Scheduled export job over ledger (P17+); format per regime at P18 |
| Record keeping | Identity + transaction records retained `aml.record_retention_years` (typically 5–10) **after relationship ends** | Retention map §6; overrides shorter privacy-driven deletion (legal hold beats erasure) |
| Training + audit trail | Business deliverable | Admin audit trail (rule 15) is the evidence substrate |

## 4. Transaction monitoring — hook points (built pre-P15, tuned at P15/P18)

| Hook | Where | What fires |
|---|---|---|
| Deposit intent / webhook settled | `payments` state machine (P17) | Velocity vs `aml.velocity_windows`; instrument-country vs geo; structuring detection (many sub-threshold deposits) |
| Withdrawal request | `payments` state machine | KYC-level gate, `aml.sof_threshold` check, minimal-play ratio (deposit→withdraw with little wagering = classic laundering pattern), threshold-based **manual review queue** (P12 admin) |
| Wallet ops (incl. faucet pre-real-money) | `wallet` domain service | Same velocity rails exercised on `TST` from P4/P10 — the machinery is proven before money is real |
| Gameplay settlement | game-engine → wallet | Chip-dumping / deliberate-loss transfer patterns (poker collusion heuristics, P10) double as AML signals |
| Risk score change | `risk` engine | allow / flag / limit / review / freeze; freeze = money-op kill-switch per user, audited |

All thresholds jurisdiction-config (`jurisdiction-matrix.md` §3), evaluated server-side, and logged to the append-only audit trail.

## 5. Source-of-funds checks

Trigger classes (any → L2 requirement + review-queue case): cumulative deposits over `aml.sof_threshold` per window; single large deposit; risk-engine flag (velocity, instrument churn, geo mismatch); regime-specific affordability triggers (UK-class — see `responsible-gaming-obligations.md`, affordability row). While pending: deposits capped or blocked per config; withdrawals of verified funds handled per counsel guidance (config, not code).

## 6. Record-keeping & retention (shape)

| Record | Where | Retention driver |
|---|---|---|
| KYC verdicts, reason codes, provider refs | `kyc_cases` (PG) | `aml.record_retention_years` post-relationship |
| Minimal verified PII (DOB, legal name, doc country) | `users.user_pii`, encrypted | Same; erasure via crypto-shred **after** holds expire (`../02-domains/users.md`) |
| Raw ID documents | **Provider-side by preference** (OQ-03 selection criterion) | Provider contract must satisfy regime retention |
| Ledger + game events | Append-only PG | AML/tax retention (longest wins) |
| Review-queue decisions | Admin audit trail | Same |

## 7. Data-protection interplay

- **PII minimization:** store only what gates decisions need (`../02-domains/kyc-verification.md` §7). Document images never transit our storage if the vendor allows it.
- **Encryption:** PII fields encrypted at rest (keys via secret manager, OQ-06); TLS 1.2+/1.3 in transit; backups encrypted (`../07-operations/backup-disaster-recovery.md`).
- **No PII in logs** — rule 15; scrub tests in `../07-operations/observability.md` §2.
- **Erasure vs retention conflict:** GDPR-class erasure requests honored **except** records under AML/tax legal hold; the hold-aware deletion design is `../02-domains/users.md` §6 + `../07-operations/backup-disaster-recovery.md` §8; finalize at P15.
- **Residency:** `data.residency_region` may constrain hosting + Sentry (OQ-06, OQ-10) — revisit both at P15.

## 8. Blocked-on ledger

| Item | Blocked on |
|---|---|
| Every threshold value, doc set, retention duration | **OQ-01** (P15) |
| Vendor adapter, screening bundling, doc custody | **OQ-03** (P16) |
| Real deposit/withdrawal monitoring live | OQ-02 (P17) |
| Regime report formats, FIU endpoints, geo cross-check live | P18 |

Pre-P15 build (not blocked): port + fake provider, level gates, review-queue model, KYT hook points with config-key thresholds, retention/erasure design — per `../02-domains/kyc-verification.md` §10.
