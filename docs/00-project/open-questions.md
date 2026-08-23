# Open Questions

Every UNDECIDED item lives here with a stable ID (`OQ-nn`). Docs and ADRs reference these IDs; nothing else in the repo is allowed to silently resolve them. When an OQ is decided: record the decision + date + decider here, update the linked ADR to ACCEPTED, and update `docs/progress.md` if it unblocks a phase.

**Ranked by launch impact. OQ-01 blocks everything real-money; nothing below it matters until it moves.**

---

## OQ-01 — Jurisdiction(s) and licensing regime 🔴 LAUNCH-BLOCKING
**Status:** OPEN · **Owner:** business + qualified gaming counsel · **Blocks:** P15→P18, OQ-02, OQ-03, OQ-08 · **ADR:** ADR-016 (RNG cert lab), `docs/06-compliance/*`

**Question.** Which market(s) will the platform legally operate in, and under which license?

**Why it's first.** Jurisdiction determines: KYC depth and acceptable documents, AML/KYT thresholds and reporting duties, RNG certification requirements (e.g. GLI-19), responsible-gaming obligations, data-protection law, tax treatment, permitted game types (poker is a "skill game" in some regimes and gambling in others), advertising rules, and geo-fencing obligations. No PSP or KYC vendor can even quote us without knowing the license.

**Hard constraint.** Several major markets prohibit or heavily restrict real-money games of chance. **India's Online Gaming Act 2025 is an outright ban on real-money online games** — India cannot be a target market for the real-money product regardless of the skill/chance argument. Other markets (USA state-by-state, China, most of the Gulf) are prohibited or fragmented. This is a launch-blocking legal decision that requires qualified counsel, not engineering judgment. The platform is built to geo-fence from day one so that whatever is chosen can be enforced.

**Options (illustrative, for counsel to evaluate):**
| Route | Examples | Trade-offs |
|---|---|---|
| Established offshore license | Malta (MGA), Isle of Man | Reputable, PSP-friendly, strong RG/AML duties, slower + costlier, strict ongoing compliance |
| Fast offshore license | Curaçao (new LOK regime), Anjouan | Cheap/fast, weaker reputation, fewer PSP options, tightening rules |
| National/local license per market | e.g. UK, Ontario, EU country regimes | Direct market access, heaviest per-market cost, needed per market anyway for many geos |

**Recommendation.** Engage specialized gaming counsel now (OQ-11); shortlist 2–3 regimes against target-market list, PSP availability, and cost; decide before P15. Engineering proceeds jurisdiction-agnostic: all jurisdiction-dependent values are configuration (`docs/06-compliance/jurisdiction-matrix.md`).

---

## OQ-02 — Payment gateway / PSP 🔴 blocked on OQ-01
**Status:** OPEN · **Blocks:** P17 · **ADR:** ADR-014 (PROPOSED)

Which PSP(s) for deposits and withdrawals? Gambling is a high-risk merchant category: mainstream PSPs (Stripe, Adyen standard accounts) exclude it; realistic options are gambling-specialist PSPs and aggregators, which are gated on the license (OQ-01). Multi-PSP is likely eventually (redundancy, per-market methods).
**Engineering stance:** `PaymentProviderPort` abstraction (`docs/02-domains/payments.md`); orchestration, ledger integration, webhook handling, and reconciliation are PSP-agnostic and built/tested against a fake provider on test currency. **Recommendation:** shortlist only after OQ-01; require: license acceptance, payout API, signed webhooks, statement/settlement file API.

## OQ-03 — KYC method & provider 🔴 blocked on OQ-01
**Status:** OPEN · **Blocks:** P16 · **ADR:** ADR-015 (PROPOSED)

Which identity-verification provider and which verification depth (doc scan + liveness vs database checks vs both), driven by license requirements. **Engineering stance:** `KycProviderPort` + level model L0/L1/L2 with jurisdiction-configurable requirements (`docs/02-domains/kyc-verification.md`). **Recommendation:** decide with OQ-01; evaluate on supported documents for target markets, sandbox quality, webhook model, PEP/sanctions screening bundling, price per check.

## OQ-04 — iOS distribution strategy 🟡 deferred
**Status:** OPEN · **Blocks:** P20 only

There is no general sideloading path on iOS. Realistic options, none chosen:
| Option | Reality |
|---|---|
| EU alternative marketplaces / web distribution (DMA) | EU-only users, needs Apple entitlement + notarization; gambling apps face extra review; viable only if EU is a licensed target market |
| Apple Developer Enterprise certificate | ToS explicitly forbids consumer distribution; certificates get revoked; business-killing risk — document as NOT viable long-term |
| PWA | No native performance/Keystore equivalent, weaker hardening + push story; acceptable as a thin lobby/account companion at most |
| App Store proper | Requires licensed operation in every storefront country offered + Apple gambling entitlements; realistic *only after* OQ-01 |
**Recommendation:** defer; revisit after OQ-01 (App Store with license, or DMA web-distribution if EU-licensed). Nothing in the architecture is Android-exclusive except the hardening layer.

## OQ-05 — Which casino-style game launches first 🟢 low structural impact
**Status:** OPEN · **Blocks:** P8 content only (contract makes it structurally irrelevant)

Candidates (all multiplayer-capable, fast rounds, house-banked or pooled):
| Candidate | Notes |
|---|---|
| Crash | Social multiplayer, provably-fair-friendly (commit-reveal), simple rules, strong engagement |
| Hi-Lo / card duel | Simplest engine, good contract validation |
| Multiplayer roulette-style wheel | Familiar, pure chance — worst for skill-positioning under some regimes |
| Andar Bahar / Teen Patti | Regional appeal but tied to markets that ban RMG (see OQ-01) |
**Recommendation:** Crash — real-time and social (fits "against strangers"), trivially provably fair, and exercises the whole contract (timers, rounds, concurrent players). Decide by P8 planning; P6/P7 don't depend on it.

## OQ-06 — Secret manager + cloud/hosting provider 🟡 needs owner confirmation
**Status:** OPEN — recommendation made, awaiting confirmation · **Blocks:** parts of P0/P1 infra provisioning · **ADR:** ADR-011 (PROPOSED)

ADR-011 compares HashiCorp Vault vs cloud-native secret managers, and hosting options. **Recommendation:** AWS (ECS Fargate → EKS later, RDS Postgres, ElastiCache Redis) + AWS Secrets Manager; Cloudflare in front as WAF/CDN. Vault is more powerful (dynamic DB creds, transit encryption) but is an ops burden a small team shouldn't carry at start. **Confirm before infra spend.** Until confirmed, everything infra-touching stays provider-agnostic (containers + env-var injection).

## OQ-07 — Poker variant & format 🟢
**Status:** OPEN — recommendation made · **Blocks:** P9 planning detail

**Recommendation:** No-Limit Texas Hold'em, cash tables (2–6 seats), fixed stake tiers at launch; tournaments/Sit-n-Go later (they add lifecycle complexity: registration, blind schedules, multi-table balancing). The table/seat/hand architecture in `docs/02-domains/poker.md` is variant-agnostic where cheap.

## OQ-08 — Real currency/-ies & payment rails 🔴 blocked on OQ-01
**Status:** OPEN. Fiat currencies follow the target market. Crypto deposits are NOT recommended before licensing (AML burden, PSP conflicts, some regimes prohibit). Ledger is multi-currency by design (currency column, no cross-currency entries in one transaction); launch runs on `TST` test credits only.

## OQ-09 — Push notification transport (off-store Android) 🟢
**Status:** OPEN — recommendation made · **Blocks:** parts of P11

FCM works on sideloaded apps **only when Google Play services is present** — true for most devices, false for de-Googled ones. Options: FCM-only; FCM + WS/polling fallback; self-hosted (UnifiedPush/ntfy). **Recommendation:** FCM where available + in-app WS/poll fallback for all critical notifications (nothing critical may be push-only); revisit self-hosted push only if de-Googled share proves material.

## OQ-10 — Observability/error-tracking SaaS vs self-host 🟢
**Status:** OPEN — recommendation made. **Recommendation:** Sentry SaaS (backend + Flutter) + self-hosted Grafana/Prometheus/Loki. Data-residency constraints from OQ-01 may force self-hosting Sentry (GlitchTip) — revisit at P15.

## OQ-11 — Legal entity structure & counsel engagement 🔴 prereq to OQ-01
**Status:** OPEN · **Owner:** business. Operating entity/-ies location, banking relationships, and engagement of specialized gaming counsel are prerequisites to licensing and PSP applications. No engineering dependency, but P15 cannot close without it. **Recommendation:** start immediately in parallel with P0.

## OQ-12 — Play Integrity API adoption 🟢
**Status:** OPEN — recommendation made. Play Integrity works for sideloaded apps on Play-services devices (verdicts: device integrity yes; `MEETS_DEVICE_INTEGRITY` achievable; app-identity verdict will report "unrecognized app" since we're off-Play — that field is ignored, not trusted). On de-Googled devices it's unavailable. **Recommendation:** use as ONE weighted risk signal into the risk engine (P10), never a hard gate; fallback = the rest of the hardening signal set (`docs/04-security/mobile-app-hardening.md`).

---

## Process
- New ambiguity discovered while building → add an OQ here (next free number) instead of inventing a business rule. Note it in the phase completion report.
- OQs with a recommendation still require an explicit owner decision — a recommendation is not a decision.
