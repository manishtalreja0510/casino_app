# Domain: Fraud & Risk Engine (`risk`)

Phase: **P10** (v1) · ADR: **ADR-018** · Module: `risk` in `apps/api`. Consumes signals from every other domain; owns scoring, actions, and manual-review cases. Payments-era signals (deposit/withdrawal) are shaped now, activated at **P17**; AML/KYT configuration becomes real at **P18** (post-OQ-01).

## 1. Purpose

Detect and act on abuse — multi-accounting, collusion, chip dumping, client tampering, faucet/velocity abuse, and (later) payment fraud and money laundering — while honoring rule 1: client-side signals are *evidence*, never a gate. The engine converts heterogeneous signals into per-user and per-session risk scores, applies a graduated action ladder, and feeds human review queues in the admin panel (P12).

**Non-goals (v1):** ML models (explicitly later — v1 is rule-based with configurable weights so an ML scorer can slot in behind the same interface); KYT vendor integration (P18); chargeback handling (P17, `payments` owns the state machine, `risk` scores it).

## 2. Owned data (module-owned tables; other modules access via exported services only)

Built in migration `0009_risk_rg` (P10). All tables live in the `risk` schema.

| Table | Contents |
|---|---|
| `risk.signals` | append-only, **enforced by trigger**: id (UUIDv7), user_id?, session_id?, device_id?, match_id?, source, type, payload (jsonb, no PII beyond opaque ids), `weight_at_ingest`, `client_only`, expires_at, created_at. The weight is frozen at ingest so a later rule change cannot retroactively alter what an action was based on — a case must be defensible against the rules as they stood |
| `risk.rules` | type, weight, ttl, `client_only`, enabled, description. Cached in memory and reloadable without a deploy; admin-editable in P12 |
| `risk.actions` | applied actions: subject, action (flag/limit/require_review/freeze), reason, evidence (jsonb, frozen at the decision), applied_by, expires_at, lifted_by/at |
| `risk.cases` | manual-review cases: state, priority, reason, evidence bundle, opened/resolved |
| `risk.device_links` / `risk.ip_links` | identity-graph edges: device_id↔user_id, ip↔user_id with first/last seen and occurrence counts, built incrementally from session starts pushed by `auth` |

**No `risk_scores` table.** A score is derived from the live signals every time it is asked
for, rather than cached in a row that can silently disagree with the evidence under it. The
snapshot that matters — the one an action was taken on — is frozen into `risk.actions.evidence`
and the case, which is the only place a stale number would ever be defended. A hot cache in
Redis is available if scoring ever costs enough to need one (rule 7: it would be a cache,
never truth).

**No separate `risk.case_evidence`.** Evidence rides on the case as jsonb at P10; it becomes
a table when P12's review UI needs to attach and annotate items.

Redis: hot score cache (short TTL), velocity counters (sliding windows), signal dedup keys. Postgres is truth (rule 7); losing Redis loses only counter warm-up.

## 3. Signal model

Every signal: `{source, type, subject (user/session/device), weight, ttl, payload}`. Weight and ttl come from `risk_rules` config, not the emitter — emitters report facts, the engine assigns meaning. Expired signals stop contributing to scores but remain in `risk_signals` (append-only) for case evidence.

### Signal catalog (v1)

| Class | Signals | Source | Notes |
|---|---|---|---|
| **Client hardening** | root detected; emulator detected; Frida/Xposed/hook framework detected; debugger attached; APK signature self-check mismatch; Play Integrity verdict (per **OQ-12**: `MEETS_DEVICE_INTEGRITY` achievable off-store on Play-services devices; app-identity field ignored; absent verdict on de-Googled devices is *neutral*, not negative) | app → authed reporting endpoint | Client-only evidence. **Degrade-don't-hard-block** (§6). Absence of a report is itself weak signal (tampered clients strip reporting). See `docs/04-security/mobile-app-hardening.md` |
| **Network** | IP reputation (datacenter/hosting ASN, known-abuse lists); geo velocity (impossible travel between sessions); VPN/proxy/Tor indicators | `auth` session creation + periodic re-check | Also feeds geo-fencing enforcement at P18 (enforcement itself lives in `auth`/`platform` config; risk only scores) |
| **Identity / multi-accounting** | device shared across N accounts; IP shared across N accounts (with NAT/mobile-CGNAT dampening); same device+IP pair at one poker table | `auth` sessions → `device_links`/`ip_links` graph | Graph queries: connected components over device/IP edges; component size + recency drive weight |
| **Financial velocity** | faucet claim frequency/volume (now); deposit velocity, withdrawal velocity, deposit-play-withdraw cycle time, method churn (shaped now, live at **P17**) | `wallet` (faucet), `payments` (P17) | Same counter framework serves both; only the emitters change |
| **Gameplay — poker collusion** | co-seating frequency (pairs/groups seated together far above random expectation for the stake pool); chip-flow asymmetry (net chip transfer between specific players across hands, normalized by hands played); fold-to-specific-player patterns (player folds to raises from partner at anomalous rate, incl. folding strong ranges detectable post-hoc from mucked-card logs); soft-play indicators (check-down frequency when partner all-in) | `games/poker` hand-completion events → stats aggregation job | Heuristic v1; thresholds config. Evidence = hand-history export (§7) |
| **Gameplay — chip dumping** | one-sided all-in/fold sequences transferring stacks; repeated heads-up matches between linked accounts with lopsided outcomes | poker + any p2p game | Cross-checked against identity graph — dump between linked accounts scores much higher |
| **Bonus abuse (shape only)** | multi-account bonus claiming, wager-requirement laundering | future promotions domain | Signal types reserved in catalog now so schema doesn't churn |

## 4. Scoring

- **Rule-based v1.** Score = bounded weighted sum of live (non-expired) signals per subject; rules and weights in `risk_rules` (DB-backed config, hot-reloadable via `platform` config cache, changes audit-logged and admin-editable in P12 with role `risk`).
- **Per-user at P10.** Per-session scoring is designed for and not built: `risk.signals` carries `session_id`, so a session-scoped scorer is additive. Nothing today degrades a single session while leaving the account alone.
- **Two numbers, not one.** Every score carries `total` and `serverEvidence` — the part the server observed for itself. The ladder's first three rungs read `total`; `freeze` reads `serverEvidence` alone, which is how §6 stops being a policy someone has to remember (see §6).
- **Deterministic and explainable:** every score snapshot stores contributing signal refs — required for case review and for defending actions to users/regulators.
- **ML explicitly later:** the scorer sits behind an internal `RiskScorer` interface; a model-based scorer is a post-launch candidate once labeled outcomes (case resolutions) accumulate. Not before.

## 5. Action ladder

`allow → flag → limit → require-review → freeze`

| Action | Effect | Applied by | Lifted by |
|---|---|---|---|
| allow | default; signals recorded only | system | — |
| flag | visible in admin, extra logging, lowers thresholds for next rung | system or admin (`risk`, `support` read-only) | auto on ttl expiry, or admin `risk` |
| limit | caps: faucet denied, stake tiers restricted, table-join throttled, (P17) deposit/withdrawal caps | system or admin `risk` | admin `risk`; audit-logged |
| require-review | withdrawal (P17) or other gated op held for a manual case; play may continue per config | system (threshold rules) | case resolution by admin `risk`/`finance` |
| freeze | account state → suspended-by-risk: no login-to-play, no money ops; existing match seat handled per game disconnect policy | system (only from hard server-side evidence per §6) or admin `risk`; four-eyes if combined with ledger adjustment | admin `risk` with case resolution; superadmin override — all audit-logged |

Every apply/lift writes `risk_actions` + audit log (rule 15). Freezes always create a case (§7) — no freeze without a review path.

## 6. Degrade-don't-hard-block (normative for client-only signals)

Client hardening signals (root, hooks, signature mismatch, Play Integrity) can be forged, stripped, or legitimately triggered (rooted power users, custom ROMs). Therefore, per rule 1 and OQ-12:

- Client-only signals may raise scores, trigger `flag`/`limit`, and weight review — they may **never** alone cause `freeze` or block login.
- `freeze` requires server-observable evidence (ledger patterns, protocol violations, graph + gameplay corroboration) or admin decision.

**How this is enforced, twice.** First by arithmetic: `evaluate` decides `freeze` on
`serverEvidence`, which client-only signals never contribute to, so no quantity of them can
reach it. Second by the numbers: every client-only weight in the seeded rule set adds up to
100, and the freeze threshold is 120 — so even if the first check were deleted, a device
reporting *every* problem at once still could not freeze itself. Both are asserted in
`apps/api/test/integration/risk.int-spec.ts`, the second as a plain arithmetic test whose
job is to fail loudly the day somebody raises a client weight past the margin.
- Degradation examples: denied faucet, restricted stakes, forced re-auth, exclusion from high-stake matchmaking — silent where possible, so attackers get no oracle for which check fired.

## 7. Manual review queues

- **Case model:** `risk_cases` — states `open → in_review → pending_info → resolved(cleared | actioned | escalated)`; priority from score + money at stake; SLA targets per priority (config; e.g. frozen-user cases hours, flags days). Queue depth and SLA breaches are metrics (§10) and page on sustained breach.
- **Evidence bundle:** auto-assembled on case creation — contributing signals, score history, session/device/IP list, identity-graph neighborhood, relevant ledger transaction refs, and for poker cases a **hand-history export** (from `game_events`, rendered with all hole cards revealed — admin-only, PII-free, itself an audited PII/game-integrity read).
- **Workflow lives in admin (P12):** queues, case notes, evidence viewer, action buttons per RBAC (`docs/02-domains/admin.md`). Until P12: CLI/read-only queries; freezes via audited admin CLI.
- Case resolutions are the label source for precision tracking (§10) and future ML.

## 8. AML/KYT hook points (config now, real at P18)

- Threshold rules (deposit aggregation, structuring patterns, rapid deposit→withdraw with minimal play) defined as ordinary risk rules with **jurisdiction-configurable thresholds** from `docs/06-compliance/jurisdiction-matrix.md` — empty/inert until OQ-01 decides at P15 and P18 fills real values.
- Report-generation **stub**: a job that assembles a case's evidence into a jurisdiction-shaped report skeleton (SAR/STR-like); format finalized at P18 with counsel. Nothing auto-files.
- KYT vendor (if the license requires one) would sit behind a port like PSP/KYC — deliberately unnamed; candidate for an OQ if the license demands it (candidate OQ, noted for consistency pass only if P15 confirms the need).

## 9. Kill-switch & support integration

- `freeze` at scale (e.g. attack wave) composes with `platform` kill-switches: per-game and per-feature switches (`docs/01-architecture/system-architecture.md §6`) stop the bleeding globally; risk actions handle individuals. Risk can *recommend* a kill-switch (alert), never flip one autonomously — flips are admin ops (P12, audited, four-eyes for the real-money gate).
- **False-positive posture:** every frozen user gets an in-app notice (via `notifications`, class critical — `docs/02-domains/notifications.md`) with a support contact path; support role can view the case and escalate but not lift freezes. Target: no silent freezes, ever. Precision of freeze decisions is a first-class metric.

## 10. Metrics & retention

- **Metrics (Prometheus, OQ-10):** signal ingest rate by type; flag/limit/freeze rates; review queue depth + age; SLA breach count; case resolution split (cleared vs actioned) = precision proxy per rule — rules with high cleared-rate get weights reviewed; time-to-freeze for confirmed abuse (recall proxy).
- **Retention:** `risk_signals`/`risk_actions`/`risk_cases` retained long-term (jurisdiction-tunable at P15, default multi-year — they are evidence). Identity-graph edges pruned by last-seen age (config). Redis counters ephemeral. Retention config lives with the audit retention policy (`docs/02-domains/audit-logging.md §8`).

## 11. Phase mapping

| Phase | Risk scope |
|---|---|
| P3/P5 | emitters exist (sessions, devices, WS anomalies) — schema-compatible events, no engine |
| **P10** | **shipped**: ingestion with server-assigned weights, derived scores, the action ladder with the freeze/`serverEvidence` rule, faucet velocity, device/IP identity graph, poker chip-dump and co-seating heuristics (weighted higher when the pair is already linked), the client hardening report endpoint, and cases opened on every freeze with the evidence frozen into them. **Not shipped**: network signals (IP reputation, geo velocity, VPN/Tor — all need a data source that does not exist yet), per-session scoring, fold-pattern and soft-play heuristics, bonus abuse, and evidence *export* (evidence is stored and queryable; packaging it is P12's, with the review UI that reads it) |
| P12 | review-queue UI, action buttons, rule editing (RBAC) |
| P14 | load/abuse simulation: synthetic collusion + multi-account scenarios must be detected |
| P17 | deposit/withdrawal velocity + payment-fraud signals live; withdrawal require-review gate active |
| P18 | AML/KYT thresholds + report generation per license; geo signals feed enforcement |
