# Runbooks

Terse, actionable. Drilled in **P14** (and kill-switch/update drills before launch, rule 16/17). Every runbook ends in verification + comms + postmortem; every page in `observability.md` §5 maps to one. Format per runbook: **Trigger · First 15 minutes · Steps · Verify · Comms · Postmortem** (postmortem = blameless, within 5 business days, template `../00-project/` postmortem template — candidate addition; timeline log mandatory during any incident).

## Index

| ID | Runbook | Typical trigger source |
|---|---|---|
| a | Incident response (framework) | any page |
| b | Secret/key leak | gitleaks, report, anomaly |
| c | Certificate / pin rotation | expiry alert, emergency |
| d | APK signing-key ceremony & custody | release ops |
| e | Kill-switch operation | incident, maintenance |
| f | Forced-update emergency push | compromised client |
| g | Ledger drift / reconciliation alert | drift page |
| h | PG failover & restore | DB page |
| i | Redis loss mid-play | Redis page |
| j | DDoS surge | WAF/SLO page |
| k | Admin-account compromise | anomalous admin audit |
| l | Fraud-ring response | risk engine / analyst |

---

## a. Incident response (framework — all others plug into this)

**Trigger:** any page; any suspected security/money/compliance event.
**Severity:** SEV1 money incorrectness, security breach, full outage, forced-update misfire · SEV2 degraded gameplay/major feature down · SEV3 contained/limited impact. When unsure, start higher.
**Roles:** Incident Commander (IC — decisions/comms, not typing), Ops (hands on keyboard), Scribe (timeline log: UTC timestamped actions/observations — this log is also the regulatory-notification source, `../06-compliance/licensing-requirements.md` §5).
**First 15 min:** page ack → assign IC → open incident channel + timeline doc → classify severity → stabilize with the *smallest* effective action (prefer kill-switch/flag-off, runbook e, over deploys).
**Steps:** stabilize → diagnose (dashboards → traces → logs, `observability.md`) → remediate → watch for 2× the incident duration.
**Verify:** SLO recovery, reconciliation clean if money-adjacent, no secondary alerts.
**Comms:** internal every 30 min; player-facing status/in-app maintenance copy for SEV1/2; **regulatory breach-notification assessment for every SEV1 — duty, recipient, deadline BLOCKED ON OQ-01** (filled at P15; until then: record the assessment in the timeline).
**Postmortem:** mandatory SEV1/2; action items tracked to closure.

## b. Suspected secret/key leak

**Trigger:** gitleaks hit, secret in log/paste/artifact, provider anomaly, insider report. **Assume compromised on suspicion — rotate first, investigate after** (rule 14).
**First 15 min:** identify class (table below) → freeze the exposure (revoke token, take repo private artifact down, kill session) → start rotation → SEV per blast radius.
**Steps by class (rotate → revoke → verify → audit, in this order):**

| Class | Rotate | Revoke/invalidate | Then |
|---|---|---|---|
| DB/Redis credentials | new creds in secret manager, rolling redeploy | old creds at the DB/Redis | audit query logs for unknown access |
| JWT signing key | new kid, publish JWKS | old kid after access-TTL (10 min) window | force refresh-token rotation if refresh store touched |
| Refresh-token store exposure | n/a | global session revocation (per-user or all) | users re-login; notify affected |
| PSP/KYC/API creds (P16+) | at provider console | old keys at provider | reconcile provider statements for unknown activity |
| Webhook secrets | new secret both ends | old secret | replay-check recent webhook events |
| CI secrets | rotate in CI store; check OIDC roles for tamper | tokens minted during exposure | audit workflow-run history |
| Staging APK key | new staging key | — | low value; note only |
| **Prod APK signing key** | see `backup-disaster-recovery.md` §6/§7 — key **compromise** path: emergency forced update signed before attacker moves (runbook f) | pin/manifest trust as needed | SEV1 always |
| PII/KMS keys | KMS rotation | old key versions disabled | assess breach-notification duty (runbook a comms) |

**Verify:** old credentials provably dead (test-auth fails); no residual copies (grep CI logs, artifacts); gitleaks re-run incl. history; if in git history → history rewrite decision + all-clone invalidation.
**Comms:** per class; PII exposure escalates to breach-notification assessment (OQ-01).
**Postmortem:** always — include "why did the secret exist where it leaked".

## c. Certificate / pin rotation (ADR-013)

**Planned (trigger: pin/cert expiry page at 30d):**
1. Generate new key/cert; compute SPKI pin.
2. Ship client release adding new pin as **backup** (current+backup always live — invariant).
3. Wait for adoption ≥ threshold (version histogram, `observability.md` §4) **and** past `minSupported` ratchet.
4. Switch server cert; old pin becomes backup for one cycle; remove at next cycle.
**Emergency (server key compromised):** switch cert to the already-pinned backup key immediately (this is why the backup pin exists) → then run planned flow to re-establish a fresh backup. If *both* pins are dead: signed remote pin-set update via config channel; last resort forced update (runbook f). **A botched rotation must never brick installs — staging (own pins) first, always.**
**Abort criteria:** connect-success rate drops on canary/staging or early prod ramp → revert cert to previous key (still pinned) — abort is always possible until the old pin is removed; never remove old pin before adoption threshold.
**Verify:** TLS handshake + pin validation from real devices per flavor; WS connect success flat; no pin-failure telemetry spike.
**Comms:** none for planned; incident comms if emergency. **Postmortem:** emergency path only.

## d. APK signing-key ceremony & custody

**Trigger:** initial setup (P13), scheduled custody audit, successor-key introduction.
**Ceremony (generation):** offline, never-networked machine; ≥2 officers present; generate prod APK key + manifest-signing key + pin-update key; export **public** halves only; private material to encrypted hardware tokens/HSM.
**Custody:** ≥2 geographically separated offline copies (escrow — `backup-disaster-recovery.md` §4); **access quorum: 2 of N officers**; sealed storage with tamper evidence.
**Usage log:** every access/signing event → append-only record (who, when, artifact hash, purpose); reviewed at custody audit (also compliance evidence, `../06-compliance/licensing-requirements.md` §6).
**Usage:** per release lane (`ci-cd.md` §5) — offline signing step or HSM-service call; key never touches CI secret store or laptops.
**Verify:** signed artifact verifies against pinned certs; custody inventory check each audit.
**Postmortem:** any deviation from ceremony = incident (runbook b).

## e. Kill-switch operation (rule 16)

**Trigger:** incident stabilization, maintenance, compliance order, risk auto-trigger page.
**Switches:** global maintenance · per-game · per-feature · **real-money gate** `compliance.real_money_enabled` (four-eyes always, both directions).
**Steps — global:** announce (in-app + status) if planned → flip maintenance flag (P1 framework; API returns 503 envelope; clients show maintenance screen) → verify WS drain → do the work → flip back → watch.
**Steps — per-game drain:** flip game switch → **no new matches/seats; in-flight hands/rounds complete per game rules** (never mid-action confiscation — mirrors RG semantics) → tables empty (matches_active{game}→0) → maintenance action → re-enable staged.
**Real-money gate:** four-eyes admin action, audited; pull immediately on: money-path incorrectness (runbook g), license/compliance instruction, PSP incident. Re-enable only after verification + both approvers sign off.
**When to pull (default-yes list):** suspected money incorrectness, exploit in a game, provider compromise, regulator instruction. Pull first, diagnose second — switches are cheap.
**Verify:** flag state via admin + probe requests; drain metrics; audit log entries present.
**Comms templates (maintained with this doc):** planned-maintenance, emergency-maintenance, per-game "table paused", post-incident all-clear.
**Postmortem:** unplanned activations only.

## f. Forced-update emergency push (compromised-client scenario)

**Trigger:** shipped client with exploitable vuln / compromised update channel / key event (runbook b).
**First 15 min:** SEV1 IC (runbook a); if server-side exploitable, mitigate server-side first (kill-switch e — the API is the real boundary, rule 1/2); halt staged rollout of any in-flight release (`rollout: 0`).
**Steps:** build fixed release → emergency prod signing (runbook d quorum — escrow path if primary custody unavailable) → publish APK + signed manifest → verify update e2e from an affected build → ramp rollout fast (25→100%) → **raise `minSupported` above the bad version** per flavor (four-eyes, audited) → API rejects old clients with `UPDATE_REQUIRED` (`distribution-and-updates.md` §4).
**Verify:** version histogram drains below-min cohort; `UPDATE_REQUIRED` spike decays (a *sustained* spike = misconfig — check per-flavor floor before assuming adoption lag); update-funnel success normal; exploit telemetry stops.
**Comms:** in-app nudge (P11) + block-screen copy + download page + status note; player-honest wording (security fix, update required).
**Postmortem:** always; includes update-latency measurement vs support-window policy (`distribution-and-updates.md` §6).

## g. Ledger drift / reconciliation alert (rule 9)

**Trigger:** page — `ledger_drift ≠ 0`, reconciliation job failure/miss, escrow-vs-matches mismatch, audit-chain break.
**First 15 min:** **freeze affected scope** — smallest first: single account/match freeze via risk actions; widening to per-game switch or real-money gate (e) as evidence demands. Never "watch it".
**Steps:** identify divergent invariant (sum-zero / balance-vs-derived / escrow / chain) → investigate via **append-only sources**: `ledger_entries`, `game_events`, audit log; reconstruct expected state; diff → root-cause (code bug, partial failure, tamper — chain break ⇒ treat as security incident, add runbook k lens).
**Corrections: reversal transactions only — never edit or delete rows (⛔ rule 5).** Each correction: idempotency key, audit entry, four-eyes above threshold, linked to the incident id.
**Verify:** reconciliation green **twice** consecutively; frozen scopes reviewed and released deliberately; affected-player balances re-derived and confirmed.
**Comms:** affected players (support-drafted, honest); regulatory assessment if real money live (OQ-01, runbook a).
**Postmortem:** always, SEV1 discipline; must answer "why didn't tests/constraints catch it".

## h. PG failover & restore-from-backup

**Trigger:** primary unresponsive, corruption suspected, region loss (`backup-disaster-recovery.md` §6).
**First 15 min:** global maintenance ON (e) — stop writes before they hit a bad primary; classify: infra failure (→ failover) vs data corruption (→ PITR; failing over to a replica replicates corruption).
**Failover:** promote standby → repoint app config (secret-manager URL) → rolling restart → smoke: migrations current, health, **ledger invariants**, audit chain.
**PITR restore:** pick target timestamp (last-known-good; reconciliation history helps) → restore base + WAL to isolated instance → verify invariants there → declare data-loss window (target ≤ RPO 5 min) → swap in → game recovery: resume from restored `game_events`; unrecoverable in-flight → void+refund reversals → replay pending erasure list (`backup-disaster-recovery.md` §8).
**Verify:** reconciliation full pass, audit-chain verify, spot-check recent transactions vs any external evidence (P17+: PSP statements), SLOs green.
**Comms:** maintenance + all-clear; if any financial window voided → affected-player comms; regulatory assessment (OQ-01).
**Postmortem:** always; record timings vs RTO.

## i. Redis loss mid-play

**Trigger:** Redis down/flushed; WS mass-disconnect page.
**First 15 min:** confirm PG healthy (if both, run h first — PG outranks); let clients hit reconnect UX; optionally maintenance-gate matchmaking to shed load during warm-up.
**Steps (mostly automatic — verify, don't improvise):** Redis restored empty → per `backup-disaster-recovery.md` §3: sessions re-auth, adapters re-form rooms, engine recovers matches from snapshots+events; hands it can't recover → **void + refund reversal** (audited); queues empty; BullMQ re-driven from PG state machines.
**Verify:** reconciliation (especially **escrow == open matches** — no stuck escrow), void count vs active-match count sane, WS connect success recovered, no duplicate settlements (idempotency holds).
**Comms:** in-app notice for voided hands ("hand voided, stakes returned"); status note if prolonged.
**Postmortem:** SEV2 unless money anomaly found (then g).

## j. DDoS surge

**Trigger:** WAF alerts, latency/SLO burn, WS connect failures with traffic spike.
**First 15 min:** confirm attack vs organic (release? promo?); raise WAF posture (under-attack mode, challenge on REST; WS paths rate-tightened); verify origin unreachable except via WAF (allowlist/tunnel intact).
**Steps:** tighten per-IP/device/endpoint rate classes (Redis token buckets, auth strictest) → geo-filter obvious attack sources (consistent with geo-fencing config) → scale API/WS horizontally if absorbing → shed load: matchmaking pause before in-play disruption (e per-game drain semantics) → capture attack signature for WAF rules.
**Verify:** SLOs recover; legit-user error rates normal (watch false-positive challenges on the app's HTTP client); WS reconnect storm drains.
**Comms:** status page if player-visible; no attacker-informative detail.
**Postmortem:** SEV2+; feed signatures back into standing WAF config.

## k. Admin-account compromise

**Trigger:** anomalous admin audit entries, impossible-travel admin login, admin credential in leak, insider report.
**First 15 min:** **suspend the admin account + revoke its sessions** (superadmin action, audited); if superadmin compromised or unknown scope → freeze all admin access (admin surface kill-switch) — player gameplay continues; verify `compliance.real_money_enabled` and kill-switch states untouched.
**Steps:** audit-log replay of every action by the account since last-known-good (append-only + hash chain makes this authoritative — verify chain first) → reverse illegitimate financial effects via reversals (g discipline) → un-do config/flag changes with four-eyes → rotate admin credentials + TOTP re-enrollment; review IP-allowlist + RBAC grants; check for created/escalated accounts → root-cause entry vector (phishing, token theft, insider).
**Verify:** chain intact, no residual sessions, RBAC diff vs last-known-good clean, reconciliation green.
**Comms:** internal need-to-know during forensics; regulatory assessment (key-person/system-access duties, `../06-compliance/licensing-requirements.md` §6, OQ-01); affected players if money touched.
**Postmortem:** always, SEV1.

## l. Fraud-ring response

**Trigger:** risk-engine correlation alert (shared device/IP graphs, collusion/chip-dumping heuristics — `../02-domains/fraud-risk.md`), analyst finding, external report.
**First 15 min:** **freeze the cohort** (risk action `freeze`: money ops blocked, matchmaking blocked; current hands complete per game rules) — freeze breadth per evidence confidence; over-freeze mildly rather than let value exfiltrate; **do NOT notify targets** (generic "account under review" only — AML tipping-off discipline, `../06-compliance/kyc-aml.md` §3).
**Steps:** **evidence preservation first** — snapshot exports: ledger slices, `game_events` (hand histories), session/device/IP graphs, risk scores/timeline (append-only stores make this cheap; bundle format per SAR-readiness) → analyst review via P12 queues (expect surge — pull in extra reviewers, four-eyes on releases) → per account: release / limit / confiscate-per-ToS+reversal / report → AML: SAR/STR filing assessment where real money live (human decision, counsel process, OQ-01) → feed pattern back into risk rules.
**Verify:** cohort states consistent; no legit-player collateral left frozen > SLA; reconciliation clean after any confiscation reversals; rule updated + tested against the captured scenario.
**Comms:** per-account generic messaging; no public detail; regulator/FIU per counsel (OQ-01).
**Postmortem:** yes for novel patterns — detection-gap analysis (why did the ring reach size X before alerting).
