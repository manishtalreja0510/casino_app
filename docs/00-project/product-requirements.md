# Product Requirements

Requirements catalog. IDs are stable (`REQ-<DOMAIN>-nn`); phase mapping uses P0–P20 (`docs/MASTER_ROADMAP.md`); gated items name their blocking OQ (`open-questions.md`). Format: terse statements, MUST unless marked SHOULD. Architecture detail lives in `docs/01-architecture/*` and `docs/02-domains/*`; this doc says *what*, not *how*.

## Account & auth (ACC)

| ID | Requirement | Phase |
|---|---|---|
| REQ-ACC-01 | Signup/login with email+password (Argon2id); phone/OTP optional later. | P3 |
| REQ-ACC-02 | Access = ES256 JWT, 10-min TTL; refresh = opaque, rotating, one-time-use with reuse detection and family revocation; 30-day sliding. | P3 |
| REQ-ACC-03 | Device registration with Android Keystore-backed keypair; sensitive/financial REST calls signed with replay protection. | P3 |
| REQ-ACC-04 | Sessions persisted in PG (device, IP, geo, risk flags); global and per-user revocation ("logout everywhere"). | P3 |
| REQ-ACC-05 | Per-IP/user/device/endpoint-class rate limiting; auth endpoints strictest; brute-force lockout. | P3 |
| REQ-ACC-06 | Account states: active / suspended / self-excluded / closed; state enforced on every authenticated action. | P3 |
| REQ-ACC-07 | IP-geo recorded on every session from day one; server-side geo-fencing enforcement config-off until jurisdictions set. | P3 (scaffold), P18 (enforce) |
| REQ-ACC-08 | All auth events (login, refresh reuse, revocation, new device) audit-logged. | P3 |

## KYC-gated tiers (KYC) — provider gated on OQ-03, requirements on OQ-01

| ID | Requirement | Phase |
|---|---|---|
| REQ-KYC-01 | Level model L0/L1/L2; L0 = unverified, test currency only; L1/L2 requirements per jurisdiction config. **Gated: OQ-01** | P3 (model), P16 (enforce) |
| REQ-KYC-02 | Provider integration via `KycProviderPort` only (start verification, webhook result, re-check); no provider code outside the adapter. **Gated: OQ-03** | P16 |
| REQ-KYC-03 | KYC level gates deposits, withdrawals, and real-money play; limits per level from jurisdiction config. **Gated: OQ-01** | P16 |
| REQ-KYC-04 | Age verification via KYC satisfies RG age requirement. **Gated: OQ-01/03** | P16 |
| REQ-KYC-05 | KYC webhooks signature-verified and idempotent; manual-review queue for non-clear verdicts. | P16 |
| REQ-KYC-06 | PII encrypted at rest, provider-side storage preferred, minimal retention; never in logs. | P16 |

## Wallet & test currency (WAL)

| ID | Requirement | Phase |
|---|---|---|
| REQ-WAL-01 | Double-entry, append-only ledger in PG; entries per transaction sum to zero; no UPDATE/DELETE; corrections via reversal transactions. | P4 |
| REQ-WAL-02 | Money as BIGINT minor units + currency code; multi-currency by design; launch currency `TST`. | P4 |
| REQ-WAL-03 | Every financial mutation idempotent (idempotency key), atomic, concurrency-safe (ordered row locks). | P4 |
| REQ-WAL-04 | Accounts: user wallet per currency + house accounts (house_main, rake, bonus, match_escrow); cached balances with CHECK >= 0 for users. | P4 |
| REQ-WAL-05 | `TST` faucet with per-user limits (velocity-checked from P10). | P4 |
| REQ-WAL-06 | Transaction history API + UI (cursor-paginated). | P4 |
| REQ-WAL-07 | Scheduled reconciliation: sum-zero, balance vs derived, escrow vs open matches; drift pages a human and freezes affected scope. | P4 |
| REQ-WAL-08 | Manual adjustments only reversal-based, audited, admin four-eyes above threshold. | P4 (CLI), P12 (UI) |

## Deposits & withdrawals (PAY) — all gated: OQ-01 → OQ-02, post-P15

| ID | Requirement | Phase |
|---|---|---|
| REQ-PAY-01 | PSP integration via `PaymentProviderPort` only (deposit intent, webhook verify, payout, statement fetch). **Gated: OQ-02** | P17 |
| REQ-PAY-02 | Deposit flow: intent → redirect/SDK → signed idempotent webhook → ledger credit; state machine in PG. **Gated: OQ-02** | P17 |
| REQ-PAY-03 | Withdrawal flow: KYC-verified + risk check + threshold-based manual review → payout → webhook confirm; ledger-first pending states. **Gated: OQ-02/03** | P17 |
| REQ-PAY-04 | PSP statement reconciliation vs ledger; drift pages a human. **Gated: OQ-02** | P17 |
| REQ-PAY-05 | Chargeback/failure states modeled; fees and limits configurable per jurisdiction. **Gated: OQ-01/02** | P17 |
| REQ-PAY-06 | All real-money paths behind `compliance.real_money_enabled` (default OFF, four-eyes); P17 completes entirely in PSP sandbox. | P17–P18 |

## Casino game #1 (CG1) — content choice gated: OQ-05 (rec. Crash)

| ID | Requirement | Phase |
|---|---|---|
| REQ-CG1-01 | Implements `GameDefinition` fully (init/reduce/onTimeout/playerView/isTerminal/settle); passes contract conformance suite. | P8 |
| REQ-CG1-02 | Multiplayer vs strangers; rounds/stakes via engine config schema; stake tiers from matchmaking. | P8 |
| REQ-CG1-03 | Settlement house-banked via engine → wallet only; idempotent by match id. | P8 |
| REQ-CG1-04 | RNG via `ctx.rng` with audit-logged draws; provably-fair (commit-reveal) SHOULD where game fits. | P8 |
| REQ-CG1-05 | Full placeholder-UI game screen from ui_kit; disconnect policy configured; per-game kill-switch drains gracefully. | P8 |
| REQ-CG1-06 | Published game rules + fairness note. | P8 |

## Poker (POK) — variant per OQ-07 (rec. NLHE cash)

| ID | Requirement | Phase |
|---|---|---|
| REQ-POK-01 | NLHE cash tables, 2–6 seats, fixed stake tiers; hand lifecycle blinds→deal→betting rounds→showdown incl. side pots. | P9 |
| REQ-POK-02 | Hole cards never serialized to non-owners — enforced in `playerView`, proven by adversarial protocol tests. | P9 |
| REQ-POK-03 | Table/seat management: sit/stand/sit-out, buy-in/top-up via match escrow. | P9 |
| REQ-POK-04 | Server turn timers; disconnect grace → auto-fold/sit-out; client timers cosmetic only. | P9 |
| REQ-POK-05 | In-flight-hand crash recovery: resume from event log; unrecoverable → void hand, return stacks as of hand start, audit-logged. | P9 |
| REQ-POK-06 | Rake implemented and configurable (off for `TST`). | P9 |
| REQ-POK-07 | Reconnect within resume window rejoins the live hand at current state. | P9 |

## Matchmaking & lobby (MM)

| ID | Requirement | Phase |
|---|---|---|
| REQ-MM-01 | Redis queues per game/stake tier; atomic match formation (no double-seat, no lost buy-in under races); match record in PG. | P7 |
| REQ-MM-02 | Table directory + TTL-held seat reservation; buy-in on sit. | P7 |
| REQ-MM-03 | Lobby via REST + `/lobby` WS updates; lobby/game-select screens from ui_kit. | P7 |
| REQ-MM-04 | Cancellation/timeout flows release reservations and escrow; queue-crash recovery leaves no stuck escrow. | P7 |
| REQ-MM-05 | No self-match where relevant; rating hook stub for later fairness. | P7 |

## Notifications (NTF) — push transport per OQ-09

| ID | Requirement | Phase |
|---|---|---|
| REQ-NTF-01 | In-app inbox + per-user preferences + templates. | P11 |
| REQ-NTF-02 | Transport abstraction: in-app WS guaranteed baseline; FCM adapter where Play services present (**OQ-09**); email provider port. | P11 |
| REQ-NTF-03 | Critical class (security, RG, money) never push-only — always delivered in-app. | P11 |
| REQ-NTF-04 | Security/RG notices wired: new-device login, limit reached. | P11 |

## Responsible gaming (RG) — first-class, on for test currency

| ID | Requirement | Phase |
|---|---|---|
| REQ-RG-01 | Player-set deposit/loss/session limits, enforced server-side. | P10 |
| REQ-RG-02 | Reality checks at configurable intervals during play. | P10 |
| REQ-RG-03 | Cool-off and self-exclusion; self-exclusion blocks matchmaking + faucet (later deposits) immediately via account state. | P10 |
| REQ-RG-04 | Age verification placeholder until KYC (REQ-KYC-04). | P10 → P16 |
| REQ-RG-05 | Jurisdiction-specific RG obligations (defaults, mandatory messaging) completed per license. **Gated: OQ-01** | P18 |

## Risk (RSK)

| ID | Requirement | Phase |
|---|---|---|
| REQ-RSK-01 | Risk engine: signal ingestion, rules, per-user/session scores; actions allow/flag/limit/review/freeze. | P10 |
| REQ-RSK-02 | Client hardening signals (root/emulator/hook, signature self-check, Play Integrity per **OQ-12**) are weighted signals — degrade/flag, never hard-block. | P10 |
| REQ-RSK-03 | Velocity checks (faucet now; deposit/withdrawal-shaped for P17) and multi-accounting heuristics (device/IP graphs). | P10 |
| REQ-RSK-04 | Poker collusion/chip-dumping heuristics v1 + hand-review export. | P10 |
| REQ-RSK-05 | AML/KYT hook points with jurisdiction-configurable thresholds. **Gated: OQ-01** | P10 (config), P18 (live) |

## Admin (ADM)

| ID | Requirement | Phase |
|---|---|---|
| REQ-ADM-01 | Separate React SPA; mandatory TOTP 2FA; RBAC (support/risk/finance/ops/superadmin); IP allowlist option; own audit trail incl. PII read-audits. | P12 |
| REQ-ADM-02 | User search + account actions (suspend, force-logout, notes); wallet views + reversal-based adjustments (four-eyes above threshold). | P12 |
| REQ-ADM-03 | Game ops: live tables, per-game kill-switches, void oversight. | P12 |
| REQ-ADM-04 | Risk review queues + case notes; feature-flag/kill-switch UI with four-eyes on `compliance.real_money_enabled`. | P12 |
| REQ-ADM-05 | Audit-log browser + reconciliation dashboard. | P12 |
| REQ-ADM-06 | KYC and payments/finance ops screens. **Gated: OQ-02/03** | P16/P17 |

## Distribution & updates (DST)

| ID | Requirement | Phase |
|---|---|---|
| REQ-DST-01 | Versioned APK hosting on own domain over HTTPS: SHA-256 checksums + signed release manifest, verified by app against pinned key before install prompt. | P13 |
| REQ-DST-02 | In-app updater: version-check endpoint → download → checksum + manifest signature verify → user-driven install. | P13 |
| REQ-DST-03 | Forced update: server min-version policy per flavor; below-min clients hard-blocked (426-style) from all authenticated endpoints with update path. Must always work (rule 17). | P13 |
| REQ-DST-04 | Simple staged rollout (version-gate %); tampered manifest/APK rejected, proven by tests. | P13 |
| REQ-DST-05 | Flavors dev/staging/prod side-by-side installable, distinct ids/endpoints/keys; prod signing key offline/HSM custody. | P2/P13 |

## Non-functional requirements (NFR)

| ID | Requirement | Verified |
|---|---|---|
| REQ-NFR-01 | **Security posture:** client untrusted by definition; server authoritative for all outcomes/balances/timers/hidden info; hardening = cost-raiser reported to risk, never a boundary; no secrets in code/repo/binary. | every phase checklist; P14 pen test |
| REQ-NFR-02 | **Gameplay latency:** ~<250 ms server processing per gameplay action (receipt → state reduced → events emitted) at P14 load targets. | P14 |
| REQ-NFR-03 | **Reconnect:** disconnect ≤ ~2 min resumes via seq/ring-buffer replay; beyond window, full `playerView` resync; no duplicate-applied events. | P5, P14 |
| REQ-NFR-04 | **Availability:** 99.9% monthly target for API+WS at launch scale; graceful degradation via kill-switches; Redis loss interrupts play, never money. | P14, error budgets |
| REQ-NFR-05 | **Auditability:** every sensitive action (money, auth, admin, voids, flag changes) in the append-only hash-chained audit log; game disputes resolvable from `game_events`; no PII/secrets in logs. | P1 onward; constraint tests |
| REQ-NFR-06 | **Jurisdiction-configurability:** KYC depth, AML/KYT thresholds, RG obligations, geo-fencing, tax/rake params are configuration (`docs/06-compliance/jurisdiction-matrix.md`), not code. **Gated: OQ-01** fills values | P15 |
| REQ-NFR-07 | **Scale baseline:** 5k concurrent WS connections, 500 concurrent tables (tune in P14 plan); horizontal WS via Redis adapter. | P14 |
| REQ-NFR-08 | **API compatibility:** additive within `/v1`; breaking changes = new version + forced-update plan tolerant of sideload lag. | ongoing |
