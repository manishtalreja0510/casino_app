# Open Questions

Every UNDECIDED item lives here with a stable ID (`OQ-nn`). Docs and ADRs reference these IDs; nothing else in the repo is allowed to silently resolve them. When an OQ is decided: record the decision + date + decider here, update the linked ADR to ACCEPTED, and update `docs/progress.md` if it unblocks a phase.

**Ranked by launch impact. OQ-01 blocks everything real-money; nothing below it matters until it moves.**

---

## OQ-01 — Jurisdiction(s) and licensing regime 🔴 LAUNCH-BLOCKING
**Status:** DELEGATED (2026-08-23, owner) — owned by a separate licensing/compliance team; **not an engineering blocker for development** · **Still blocks:** P18 real-money launch · **ADR:** ADR-016 (RNG cert lab), `docs/06-compliance/*`

> **Decision (2026-08-23).** A separate team handles all licensing. Engineering does **not** wait on it and does **not** attempt to answer it. What this changes: P15 is no longer an engineering gate phase — it becomes a hand-off checkpoint where that team's answers land. What it does **not** change: `compliance.real_money_enabled` stays OFF by default (rule 11), geo-fencing capability is still built (rule 13), and P18 real-money enablement still cannot complete until the licensing team delivers jurisdiction + license. All jurisdiction-dependent values remain configuration, never hardcoded.

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

## OQ-02 — Payment gateway / PSP 🟡 deferred; interim path decided
**Status:** DEFERRED (2026-08-23, owner) — PSP choice still open; **development uses direct-credit funding** · **Blocks:** P17 only · **ADR:** ADR-014 (PROPOSED), ADR-022 (ACCEPTED, interim)

> **Decision (2026-08-23).** Until a PSP is chosen, funding is **static/direct-credit**: the user submits an amount and it is credited straight to their wallet. This is a real ledger transaction (double-entry, idempotent, audited — rules 4-6 still apply in full); only the *external money movement* is skipped. Implemented in P4 behind the `payments.dev_direct_credit` flag, which is **force-disabled whenever `compliance.real_money_enabled` is ON** — see ADR-022. `PaymentProviderPort` still exists so the real PSP slots in at P17 without reshaping the wallet.

Which PSP(s) for deposits and withdrawals? Gambling is a high-risk merchant category: mainstream PSPs (Stripe, Adyen standard accounts) exclude it; realistic options are gambling-specialist PSPs and aggregators, which are gated on the license (OQ-01). Multi-PSP is likely eventually (redundancy, per-market methods).
**Engineering stance:** `PaymentProviderPort` abstraction (`docs/02-domains/payments.md`); orchestration, ledger integration, webhook handling, and reconciliation are PSP-agnostic and built/tested against a fake provider on test currency. **Recommendation:** shortlist only after OQ-01; require: license acceptance, payout API, signed webhooks, statement/settlement file API.

## OQ-03 — KYC method & provider 🟡 deferred, verification skipped for now
**Status:** DEFERRED (2026-08-23, owner) — no KYC built now; design retained · **Blocks:** P16 only · **ADR:** ADR-015 (PROPOSED)

> **Decision (2026-08-23).** Identity verification is **skipped for now**; the documented design stays as-is for when it returns. Engineering impact: every account operates at level **L0**; the L0/L1/L2 level model stays in the domain model as configuration so that level checks are present (and trivially satisfied) rather than absent — P16 then swaps in a real provider adapter without touching call sites. Age verification therefore has no technical enforcement until P16; recorded here so it cannot be forgotten before real money (rule 12).

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

## OQ-05 — Which casino-style game launches first 🟢 DECIDED
**Status:** DECIDED (2026-08-23) — **Crash** · **Was blocking:** P8 content only · **Shipped in:** P8, rules at `docs/02-domains/crash-game-rules.md`

> **Decision (2026-08-23).** Crash, on the standing recommendation below. Taken by
> engineering after the owner asked for P8 to proceed without naming a game; recorded here
> so it can be reversed cheaply rather than assumed. **What a reversal would cost:** the
> game module, its rules doc, and the two game-specific `ui_kit` components — the isolation
> §9 of `casino-game.md` demands. What it would *not* touch: the engine, matchmaking,
> escrow and settlement, provable-fairness plumbing, or the round-based admission model
> (ADR-023), all of which are game-agnostic and now proven by a second game. If a different
> candidate is wanted, say so and it is a phase of work, not a redesign.
>
> Crash also forced two genuinely useful things into the platform that a simpler candidate
> would have deferred: a replayable clock (ADR-023) and house-banked settlement (ADR-024).

Candidates (all multiplayer-capable, fast rounds, house-banked or pooled):
| Candidate | Notes |
|---|---|
| Crash | Social multiplayer, provably-fair-friendly (commit-reveal), simple rules, strong engagement |
| Hi-Lo / card duel | Simplest engine, good contract validation |
| Multiplayer roulette-style wheel | Familiar, pure chance — worst for skill-positioning under some regimes |
| Andar Bahar / Teen Patti | Regional appeal but tied to markets that ban RMG (see OQ-01) |
**Recommendation:** Crash — real-time and social (fits "against strangers"), trivially provably fair, and exercises the whole contract (timers, rounds, concurrent players). Decide by P8 planning; P6/P7 don't depend on it.

## OQ-06 — Secret manager + cloud/hosting provider 🟢 confirmed, with local-first mandate
**Status:** DECIDED (2026-08-23, owner) · **ADR:** ADR-011 (ACCEPTED), ADR-021 (ACCEPTED, local-first)

> **Decision (2026-08-23).** AWS + AWS Secrets Manager confirmed as the eventual hosting/secrets target, **with a hard local-first mandate**: for the whole development period the stack must run **free on localhost** — zero cloud dependency, zero cloud spend, no account required to develop or test. Docker Compose (Postgres + Redis) is the primary local path, with native local services as a documented fallback. Cloud provisioning happens only when explicitly approved; until then everything infra-touching stays provider-agnostic (containers + env-var injection). See ADR-021.

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

## OQ-13 — Player-facing 2FA & step-up auth for withdrawals 🟢
**Status:** OPEN · **Blocks:** parts of P17 planning · Raised by `../02-domains/authentication.md` §13

When to introduce player-facing 2FA (TOTP and/or passkeys — admin TOTP is already mandatory at P12), and whether withdrawal operations should require step-up authentication regardless of session state. **Recommendation:** decide by P17 planning, alongside withdrawal-flow design; the auth model (device binding + request signing) already covers the transport, so this is a UX/risk-policy choice, not an architecture change.

## OQ-14 — Chargeback-shortfall accounting & dispute tooling depth 🟢
**Status:** OPEN · **Blocks:** parts of P17 planning · Raised by `../02-domains/payments.md` §11

How chargeback shortfalls are accounted (dedicated `chargeback_loss` house account is the sketched approach) and how deep dispute-evidence tooling goes (evidence capture, PSP dispute API integration vs manual). **Recommendation:** finalize in P17 planning once the PSP (OQ-02) and its dispute model are known; the ledger design already supports it via reversal transactions + a house account.

---

## Process
- New ambiguity discovered while building → add an OQ here (next free number) instead of inventing a business rule. Note it in the phase completion report.
- OQs with a recommendation still require an explicit owner decision — a recommendation is not a decision.
