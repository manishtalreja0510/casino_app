# MASTER ROADMAP

21 phases (P0–P20). Numbering is canonical — all docs, `progress.md`, and phase plans use these IDs. Each phase gets a detailed plan from `docs/phases/PHASE_TEMPLATE.md` **before** implementation starts; no phase auto-starts the next.

**Why this count:** phases are cut for manageable scope, clear dependencies, independent testability, and low blast radius — a phase should be revertible/haltable without stranding half-built money paths.

## Dependency graph

```
P0 ─ P1 ─┬─ P3 ─ P4 ─┬─ P5 ─ P6 ─ P7 ─┬─ P8 ─┐
         │           │                 └─ P9 ─┼─ P10 ─ P14 ──────────┐
    P2 ──┘           │                        ├─ P11                 │
                     │                        ├─ P12                 ├─ P18 (real-money launch)
                     │                        └─ P13 ────────────────┤
Compliance track (business, runs from day 0):                        │
    OQ-11 → OQ-01 → OQ-02/OQ-03  ──────────── P15 ─ P16 ─ P17 ───────┘
Design track:  designer onboarding ─────────── P19 (parallel to P10+)
iOS:           OQ-04 ───────────────────────── P20 (unscheduled)
```

Rules encoded in the ordering:
- Foundations (monorepo, CI/CD, flavors, secrets, environments) come first (P0–P2).
- Auth, wallet-on-test-currency, and the game contract precede any game (P3–P6).
- Both launch games are built and hardened **entirely on test currency** (P8–P10, P14).
- Compliance gate, KYC, PSP, real-money enablement are late phases **explicitly blocked on OQ-01/02/03** (P15–P18).
- Distribution/updater (P13) and admin (P12) are their own phases.
- P2 establishes tokens/ui_kit/router/placeholder theme early so P19 (blocked on designer onboarding) is a restyle, not a rewrite.
- Load testing and security review (P14) gate any real-money launch (P18).

## Phase index

| # | Name | Depends on | Blocked on | Risk | Complexity |
|---|---|---|---|---|---|
| P0 | Foundations | — | — | Low | Medium |
| P1 | Backend platform core | P0 | — | Medium | Medium |
| P2 | Flutter platform core | P0 | — | Medium | Medium |
| P3 | Auth & identity | P1, P2 | — | High | High |
| P4 | Wallet & ledger (test currency) | P3 | — | High | High |
| P5 | Real-time core | P3 | — | High | High |
| P6 | Game engine & contract | P4, P5 | — | High | High |
| P7 | Matchmaking & lobby | P6 | — | Medium | Medium |
| P8 | Casino game #1 (test currency) | P7 | OQ-05 (content only) | Medium | Medium |
| P9 | Poker (test currency) | P7 | OQ-07 (rec. exists) | High | Very high |
| P10 | Risk & responsible gaming v1 | P8 or P9 | — | High | High |
| P11 | Notifications | P5 | OQ-09 (rec. exists) | Low | Medium |
| P12 | Admin panel v1 | P4; risk queues need P10 | — | Medium | Medium |
| P13 | Distribution & updates | P2; enforcement needs P1 | — | High | Medium |
| P14 | Hardening & load | P8–P13 | — | High | High |
| P15 | Compliance gate closure | business track | **OQ-01/02/03/11** | Critical | — (decision) |
| P16 | KYC integration | P15 | OQ-03 decided | High | Medium |
| P17 | Payments (PSP) | P15, P16 | OQ-02 decided | Critical | High |
| P18 | Real-money enablement & launch | P14–P17 | all gates green | Critical | High |
| P19 | Design integration | P2 baseline; screens as built | **designer onboarding** | Medium | Medium |
| P20 | iOS (unscheduled) | P18 learnings | **OQ-04** | High | High |

---

## P0 — Foundations
**Objective:** a monorepo where every later phase has rails: tooling, CI, environment scaffolding, secrets hygiene. **Why:** every later mistake is cheaper to prevent here; secrets discipline (rule 14) must exist before the first line of app code.
**Scope:** pnpm workspaces + Turborepo; melos; repo layout per `system-architecture.md §2`; lint/format/typecheck baselines (ESLint, Prettier, dart analyze, custom "no hardcoded style" lint placeholder); GitHub Actions CI skeleton (lint + test + build per workspace, path-filtered); `.example` env templates + gitignore rules; commit conventions; PR template referencing security checklist; docs workflow wired (progress.md updates).
**Out of scope:** any app feature; infra provisioning beyond CI (cloud awaits OQ-06 confirmation).
**Deliverables:** building empty apps (`apps/api` hello-health, `apps/mobile` empty shell compiles per flavor — scaffolds only, no features), green CI, contributor README.
**Testing:** CI proves lint/test/build on all workspaces. **Security:** secret-scanning in CI (gitleaks); branch protection.
**Acceptance:** fresh clone → documented bootstrap → all checks green locally and in CI.
**Enables:** everything.

## P1 — Backend platform core
**Objective:** the NestJS chassis every domain module plugs into. **Why:** error model, config, observability, flags, and audit foundations must predate the first domain or they'll be retrofitted inconsistently.
**Scope:** NestJS app structure + module conventions; config module (env-schema-validated); PG (Drizzle + SQL-first migrations, ADR-020) + Redis wiring; global error model + error codes from `packages/contracts`; pino + OTel baseline; health/readiness endpoints; feature-flag + kill-switch framework (DB-backed, Redis-cached, incl. `compliance.real_money_enabled` OFF and maintenance mode); audit-log foundation (append-only, hash-chained table + writer service); BullMQ scaffold; rate-limit middleware skeleton.
**Out of scope:** any domain logic; admin UI for flags (P12 — until then, migration/CLI-managed).
**Deliverables/acceptance:** documented module template; failing flag lookups fail closed; audit writer tested incl. immutability (constraint tests proving UPDATE/DELETE rejected); maintenance mode returns proper 503 envelope; CI green.
**Security:** checklist run; log-scrubbing tests (no PII/token fields serialized).
**Enables:** P3+ (all backend phases).

## P2 — Flutter platform core
**Objective:** the app chassis + the entire UI-strategy skeleton (rule 25–27). **Why:** tokens/ui_kit/router/asset-registry must exist before the first screen so P19 is a restyle.
**Scope:** flavors dev/staging/prod (applicationId suffixes, names, icons, endpoints via `--dart-define-from-file`, gitignored env files + `.example`); Riverpod v2 + freezed scaffold; go_router central typed config; `ui_kit` package: token system (color/type/spacing/radius/motion) + plain dark placeholder theme + first components (Button, Card, Input, Dialog, Toast, EmptyState, LoadingState); `assets` package: generated registry + naming conventions + placeholder files; intent-named animation wrapper pattern (one example); generated `api_client` from `packages/contracts`; connectivity/reconnect UX primitives (offline banner, retry queue for idempotent calls); error presentation mapping.
**Out of scope:** real screens beyond a dev harness ("kitchen sink" screen showing ui_kit); visual polish.
**Acceptance:** three flavors install side-by-side pointing at distinct endpoints; kitchen-sink screen renders every component from tokens only; lint forbids hardcoded styles (or checklist rule enforced in review); `docs/08-design/ui-flow-map.md` seeded.
**Security:** no secrets in Dart or binary (verified by string-dump spot check in CI); obfuscation flags wired into release builds now.
**Enables:** P3+ (all Flutter phases), P19.

## P3 — Auth & identity
**Objective:** accounts, sessions, and the trust plumbing every money/game action rides on. **Why before wallet:** every ledger row needs an authenticated, device-bound principal.
**Scope:** signup/login (email+password, Argon2id), token model (ES256 10-min access + rotating one-time refresh w/ reuse detection + family revocation), device registration (Android Keystore keypair), request signing on sensitive endpoints + replay protection, session store (PG truth, Redis cache) + revocation, per-IP/user/device rate limiting on auth, geo-check scaffold (IP-geo lookup recorded on session; enforcement config-off), account states (active/suspended/self-excluded/closed), auth screens from ui_kit, audit events.
**Out of scope:** KYC (P16), 2FA for players (later; admin 2FA is P12), social/phone login.
**Testing:** token-rotation attack tests (reuse → family revoked), signing tamper tests, brute-force lockout tests. **Security:** full checklist; threat-model review of auth flows.
**Acceptance:** app: signup→login→session persists→refresh rotates→logout everywhere works on device; forged/replayed signed requests rejected; audit trail complete.
**Enables:** P4, P5.

## P4 — Wallet & ledger (test currency)
**Objective:** the double-entry ledger (ADR-008) and wallet domain, running on `TST` credits. **Why:** money core must be built and hardened long before real money; every game needs settlement rails.
**Scope:** schema (`accounts`, `ledger_transactions`, `ledger_entries`, `balances` + zero-sum and append-only enforcement per `docs/01-architecture/database-architecture.md`); wallet domain services (credit test funds via faucet-with-limits, debit/credit, escrow ops, idempotency keys); concurrency-safe balance updates (ordered row locks); transaction history API + UI; reconciliation job v1 (sum-zero, balance drift, escrow) + alerting hook; admin CLI for manual adjustments (reversal-based, audited).
**Out of scope:** deposits/withdrawals via PSP (P17), bonuses/promotions, real currencies.
**Testing:** property/concurrency tests (parallel debits can't overdraw; idempotent replays no-op; crash mid-transaction leaves ledger consistent), constraint tests (no UPDATE/DELETE, no unbalanced tx).
**Acceptance:** simulated 1k-concurrent-op soak shows zero drift; reconciliation catches an injected fault in staging.
**Enables:** P6 settlement, P17.

## P5 — Real-time core
**Objective:** the Socket.IO layer games ride on (ADR-007). **Scope:** gateways + Redis adapter; WS ticket auth handshake; rooms/presence (`user:`, `table:`); heartbeat + connection health; per-room `seq` + event envelope; resume protocol (replay ring buffer in Redis, else full-state resync); server timer framework (engine-driven, BullMQ-backed); reconnect UX in app (banner, auto-resume); WS rate limiting + payload validation; load smoke test harness (the P14 tool starts here).
**Out of scope:** any game logic; matchmaking.
**Testing:** kill-server-mid-session tests (client resumes on another instance via adapter); duplicate/ooo event handling on client. **Acceptance:** 2-instance deployment: client survives instance kill with resume, no duplicate-applied events.
**Enables:** P6, P11 (in-app real-time notifications).

## P6 — Game engine & contract
**Objective:** the `GameDefinition` runtime (ADR-006/009) — lifecycle, persistence, RNG, settlement — validated by an internal dev-only reference game. **Why:** the contract must be proven before two real games are built against it.
**Scope:** contract interfaces in `packages/contracts` + engine runtime; match lifecycle (created→starting→in_progress→settling→settled|voided); action ingestion (validate, reduce, emit); `playerView` filtered broadcasting; append-only `game_events` + `game_snapshots`; crash recovery (snapshot+replay; void+refund path, audited); `RngService` port (CSPRNG now, certified-RNG-swappable, audit-logged draws; commit-reveal helper); settlement via wallet escrow (idempotent by matchId); turn timers via P5 framework; dev-only "coin-duel" game exercising every contract hook (test fixture, never shipped).
**Out of scope:** matchmaking (P7), shipped games (P8/P9), provably-fair UX.
**Testing:** contract conformance suite (any game can run it), recovery drills (kill engine mid-match → resume or void+refund with ledger intact), settlement idempotency, RNG draw audit completeness.
**Acceptance:** coin-duel plays end-to-end over WS on test currency across restarts with zero ledger drift.
**Enables:** P7, P8, P9.

## P7 — Matchmaking & lobby
**Objective:** getting strangers into matches. **Scope:** Redis queues per game/stake tier with atomic match formation (lock + PG record); poker-style table directory + seat reservation (TTL-held, buy-in on sit); lobby REST + `/lobby` WS updates; lobby/game-select screens; matchmaking fairness basics (no self-match where relevant, rating hook stub); cancellation/timeout flows.
**Out of scope:** ratings/leagues, private tables, tournaments.
**Testing:** concurrency (N clients race for M seats — no double-seat, no lost buy-in), queue-crash recovery (Redis flush → queues rebuild, no stuck escrow).
**Acceptance:** two fresh accounts on two devices find each other and start a coin-duel match via the lobby.
**Enables:** P8, P9.

## P8 — Casino game #1 (test currency)
**Objective:** first shipped game through the contract (which game: OQ-05; recommendation Crash). **Why after P6/P7:** it's a content plug-in, proving the platform, not shaping it.
**Scope:** game module implementing `GameDefinition`; game-specific config (rounds, stakes) via engine config schema; full placeholder-UI game screen from ui_kit (incl. game-specific components added to ui_kit, e.g. multiplier curve/round widgets); disconnect policy config; game-specific settlement (house-banked accounts per `wallet.md`); per-game kill-switch wired; game rules doc + fairness note.
**Out of scope:** visual polish, sound (P19); promotions.
**Testing:** contract conformance suite + game-logic property tests (payout table exactness vs RNG stream), full e2e on devices.
**Acceptance:** N concurrent players complete rounds on staging with correct idempotent settlement; kill-switch drains gracefully.
**Enables:** P10 (real gameplay data for risk), P14.

## P9 — Poker (test currency)
**Objective:** multiplayer NLHE cash tables (OQ-07 rec.). Highest-complexity phase. **Scope:** poker engine (hand lifecycle: blinds→deal→betting rounds→showdown; side pots; rake config off for test currency but implemented); table/seat management on P7 rails (sit/stand/sit-out, buy-in/top-up via escrow); hole-card information hiding via `playerView` (protocol-level, tested); turn timers + auto-fold/sit-out on disconnect grace; in-flight-hand crash recovery (resume from event log; unrecoverable → void hand, return stacks as of hand start, audited); multi-table support model; poker table UI from ui_kit (TableSeat, ChipStack, TimerRing, CardDealAnimation placeholder wrappers).
**Out of scope:** tournaments/SnG, other variants, chat, statistics UI.
**Testing:** hand-evaluator exhaustive tests vs known vectors; side-pot property tests; adversarial protocol tests (client asking for others' hole cards, out-of-turn actions, malformed raises); recovery drills mid-hand; 6-seat full-table e2e.
**Acceptance:** a 6-player real-device hand with a mid-hand server kill recovers correctly; no information leak found by protocol tests.
**Enables:** P10 collusion detection surface, P14.

## P10 — Risk & responsible gaming v1
**Objective:** the fraud/anti-abuse and RG domains (rule 12), on test currency. **Scope:** risk engine (signal ingestion API, rule evaluation, user/session risk scores, actions allow/flag/limit/review/freeze); client hardening signals (root/emulator/hook detection, signature self-check, Play Integrity per OQ-12) reported and weighed — degrade/flag, never hard-block; velocity checks (faucet abuse now, deposit/withdrawal-shaped for later); multi-accounting heuristics (device/IP graphs); poker collusion/chip-dumping heuristics v1 + hand-review data export; manual-review queue model (UI in P12); RG: deposit/loss/session limits, reality checks, cool-off, self-exclusion (account-state integration), age-verification placeholder pending KYC; AML/KYT hook points with jurisdiction-configurable thresholds (config only until P15).
**Out of scope:** ML models; KYT vendor integration; RG jurisdictional fine-tuning (P18).
**Testing:** rule-engine unit tests; synthetic collusion/chip-dump scenarios detected; self-exclusion blocks matchmaking + faucet immediately.
**Acceptance:** risk actions demonstrably applied end-to-end (flagged session degraded, frozen user blocked from money ops with support path).
**Enables:** P12 queues, P14, P18.

## P11 — Notifications
**Objective:** player messaging. **Scope:** notification domain (templates, per-user prefs, in-app inbox); transport abstraction: in-app WS (P5) as guaranteed baseline, FCM adapter where Play services exists (OQ-09), email provider port; critical-vs-marketing classes (critical never push-only); RG/security notices wiring (limit reached, new-device login).
**Out of scope:** marketing campaigns, SMS.
**Acceptance:** new-device login and match-start notifications delivered in-app on all devices, via FCM where available.

## P12 — Admin panel v1
**Objective:** operate the platform without SQL access. **Scope:** `apps/admin` React SPA + admin module guards (mandatory TOTP 2FA, RBAC roles: support/risk/finance/ops/superadmin, IP allowlist option, own audit trail incl. read-audits of PII); user search + account actions (suspend, force-logout, notes); wallet views + reversal-based adjustments (four-eyes above threshold); game ops (live tables, kill-switches, void oversight); risk review queues (P10) + case notes; feature-flag/kill-switch UI (four-eyes on `compliance.real_money_enabled`); audit-log browser; reconciliation dashboard.
**Out of scope:** KYC/payment ops screens (arrive with P16/P17), analytics/BI.
**Testing:** RBAC matrix tests (every endpoint × role), 2FA enforcement, audit completeness on every admin mutation.
**Acceptance:** all P4–P10 operational tasks doable via UI by correct role, each leaving an audit trail.

## P13 — Distribution & updates
**Objective:** the off-store channel (ADR-017). **Scope:** versioned APK hosting (own domain, HTTPS, SHA-256 checksums + signed release manifest); release pipeline from CI (signed staging/prod builds; prod key custody per `docs/07-operations/runbooks.md`); in-app updater (version-check endpoint, download with checksum verify + manifest signature verify against pinned key, user-driven install); forced-update: server min-version policy per flavor → hard-block screen with update path (rule 17); API min-version enforcement middleware; download-page basics; anti-tamper posture doc for the channel (signed manifest, monitoring for re-hosted modified APKs, risk-engine signals from signature self-check).
**Out of scope:** delta updates, in-app A/B rollout (staged rollout % is in scope, simple version-gate based).
**Testing:** update e2e (old build → prompt → install); forced-update lockout e2e; tampered-manifest and tampered-APK-checksum rejection.
**Acceptance:** a device on N-1 updates to N through the in-app flow; a below-min-version build cannot reach any authenticated endpoint.

## P14 — Hardening & load 🔒 gate before real money
**Objective:** prove the platform holds under load and attack, on test currency. **Scope:** load: WS soak (target: 5k concurrent connections, 500 concurrent tables baseline — tune targets in phase plan), matchmaking storms, reconnect storms, settlement bursts; chaos: instance kills, PG failover, Redis flush mid-play; full security review vs `docs/04-security/security-checklist.md`; external pen test + remediation; dependency/secret scanning burn-down; performance budgets recorded; incident-response drill (runbooks exercised, incl. kill-switches + forced update).
**Acceptance:** targets met with error budgets; pen-test criticals/highs remediated; drill completed. **This phase gates P18.**

## P15 — Compliance gate closure 🔴 decision phase
**Objective:** close OQ-01 (jurisdiction+license), OQ-02 (PSP), OQ-03 (KYC provider), with counsel (OQ-11). **Why a phase:** it's the explicit wall between "test-currency product" and "real-money product"; the business track (counsel, license application, PSP/KYC shortlisting) runs in parallel from day 0, but P16–P18 cannot start until this closes.
**Deliverables:** decisions recorded in `open-questions.md`; ADR-014/015/016 (and 011 if pending) moved to ACCEPTED; `docs/06-compliance/jurisdiction-matrix.md` filled for chosen market(s); RG obligations mapped to backlog items; geo-fencing policy defined; data-protection review (residency, retention) done.
**Acceptance:** license obtained or formally in final stage with counsel sign-off to build; PSP + KYC contracts signed with sandbox access.

## P16 — KYC integration
**Objective:** real identity verification via chosen provider (OQ-03). **Scope:** provider adapter behind `KycProviderPort`; verification flows (doc+liveness per license); level model L0/L1/L2 enforcement (limits per level from jurisdiction config); webhook handling; manual-review queue + admin screens; PII handling per `docs/06-compliance/kyc-aml.md` (encrypted at rest, provider-side storage preferred, minimal retention); age verification satisfying RG.
**Testing:** sandbox e2e all verdict paths; PII-leak log audit. **Acceptance:** user completes KYC in staging sandbox; unverified users correctly limited.

## P17 — Payments (PSP)
**Objective:** real deposits/withdrawals via chosen PSP (OQ-02). **Scope:** PSP adapter behind `PaymentProviderPort`; deposit flow (intent→redirect/SDK→webhook→ledger credit, idempotent); withdrawal flow (KYC gate→risk check→threshold manual review→payout→webhook confirm, ledger-first with pending states); PSP reconciliation (statement matching vs ledger, drift pages); payment method management; fees/limits config; failure/chargeback handling states; finance admin screens.
**Testing:** webhook replay/forgery tests; every state-machine edge in sandbox; reconciliation catches injected mismatch.
**Acceptance:** sandbox deposit and withdrawal round-trip with correct ledger + PSP-statement reconciliation. `compliance.real_money_enabled` STAYS OFF — everything proven in sandbox.

## P18 — Real-money enablement & launch readiness
**Objective:** turn it on, safely, where legal. **Scope:** geo-fencing enforcement live (IP + declared address + payment-country cross-checks per license); AML/KYT thresholds + reporting per jurisdiction; RG obligations completed per license (limits defaults, mandatory messaging); RNG certification completed (lab per ADR-016) for shipped games; real currency accounts in ledger; re-run of P14 load + security passes on final config; launch runbook (staged: internal → invited → open, with kill-switch criteria); `compliance.real_money_enabled` ON via four-eyes, in licensed geos only.
**Acceptance:** license live; certification issued; drills green; limited launch executed per runbook.

## P19 — Design integration (blocked on designer onboarding)
**Objective:** replace the placeholder look with the approved design — as a restyle. **Scope:** real token values + theme(s); ui_kit component restyle; asset drop-in via registry (final names already stable); Rive/Lottie inside existing animation wrappers; sound + haptics layer; flow adjustments via router config; `ui-flow-map.md` as onboarding input; motion/perf budget checks.
**Explicitly NOT:** logic changes, new screens beyond flow re-ordering, API changes. If the restyle demands logic change, that's a phase-plan amendment.
**Acceptance:** designer sign-off; zero changes outside ui_kit/tokens/assets/router-config/screen-layout layers (diff-audited).

## P20 — iOS (unscheduled)
Blocked on OQ-04; scoped only after OQ-01 (path differs for EU-DMA vs App-Store-with-license). Placeholder: port hardening layer, distribution story, payment rules per Apple policy.

---

## Standing risks (top, ranked)
1. **OQ-01 jurisdiction/licensing** — blocks all revenue; wrong choice = rebuild of compliance surface. Mitigate: counsel now, config-driven compliance, geo-fencing day one.
2. **PSP acceptance (OQ-02)** — high-risk MCC; no PSP = no business. Mitigate: license-first strategy, PSP-agnostic port, early shortlisting in P15 track.
3. **Poker complexity (P9)** — engine + recovery + anti-collusion is the deepest engineering risk. Mitigate: contract conformance suite, event-sourced recovery, phase isolation.
4. **Off-store trust & update channel (P13)** — a broken forced-update path is unpatchable. Mitigate: rule 17, e2e update tests every release, signed manifests.
5. **Financial drift under concurrency (P4)** — mitigated by ledger design, property tests, reconciliation-with-paging.
6. **Real-time scale (P5/P14)** — Socket.IO + Redis adapter limits; mitigated by load phase before launch and extraction-ready realtime module.
7. **Designer-arrival churn (P19)** — mitigated structurally by P2; the risk left is discipline (rule 25–27).
