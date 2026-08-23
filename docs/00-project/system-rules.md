# Non-Negotiable System Rules

Permanent rules for every contributor, human or AI, in every phase. They override convenience in every trade-off. Violating one requires an ACCEPTED ADR that explicitly supersedes it — and for rules marked ⛔, no ADR may override.

## Trust & authority
1. ⛔ **The client is always untrusted.** The APK is public and will be decompiled and instrumented. Nothing client-side is a security boundary: no balance math, no game outcome, no timer, no hidden information, no entitlement check. Client hardening is a cost-raiser reported to the risk engine, never a gate.
2. ⛔ **The server is authoritative** for all game outcomes, balances, timers, turn order, hidden information, and entitlements. Client-provided financial or game-state values are input to validate, never truth. Hidden information (e.g. poker hole cards) never leaves the server except to its owner, enforced in `playerView` at the contract level.
3. **Never promise "un-reverse-engineerable"** in any doc, UI, or marketing input. Honest language: "raises attacker cost".

## Money
4. ⛔ **Money is integer minor units** (`BIGINT` + currency code). Floats/decimals for money are forbidden everywhere — DB, backend, client display math.
5. ⛔ **Double-entry, append-only ledger in PostgreSQL is the sole financial truth.** Entries per transaction sum to zero. No UPDATE/DELETE on ledger tables; corrections are reversal transactions. Wallet balances are derived/cached views.
6. ⛔ **Every state-changing financial operation is atomic, concurrency-safe, and idempotent** (idempotency keys; row locks in consistent order; single DB transaction).
7. ⛔ **Redis never holds financial truth.** Losing Redis may interrupt gameplay; it must never lose or corrupt money.
8. **External callbacks (PSP/KYC webhooks) are idempotent and signature-verified** before any state change.
9. **Reconciliation runs on schedule** (ledger sums, balance drift, escrow vs open matches, PSP statements). Drift pages a human and freezes the affected scope; it is never auto-corrected silently.
10. ⛔ **Games never touch wallets or ledger directly.** Settlement flows only through game-engine → wallet domain services, idempotent by match id.

## Compliance
11. ⛔ **Real-money paths sit behind the compliance gate** (`compliance.real_money_enabled`, default OFF, four-eyes admin change). No real-money enablement, PSP integration, or KYC provider selection proceeds past planning before OQ-01/02/03 are decided (P15).
12. **Responsible gaming is a first-class domain** (limits, self-exclusion, age verification) — built and testable on test currency, not bolted on for launch.
13. **Geo-fencing capability exists from day one** and is enforced server-side once jurisdictions are set.

## Secrets & configuration
14. ⛔ **No secrets in code, repo, git history, or binary — ever.** Anything shipped in the APK is public. Client build config comes only from gitignored `--dart-define-from-file` files (`.example` templates committed); backend secrets only from the secret manager at deploy; CI secrets only in the CI secret store. Suspected leak → rotation runbook (`docs/07-operations/runbooks.md`), immediately.

## Audit & operations
15. ⛔ **Every sensitive action (money, auth, admin, game voids, flag changes) is audit-logged** to the append-only, hash-chained audit log. **No PII or secrets in any log** (opaque IDs are fine).
16. **Server-side kill-switches exist and work**: global maintenance, per-game, per-feature, real-money gate. Tested in staging, drilled before launch.
17. ⛔ **Forced client update must always work.** Min-version policy per flavor; it is the only security-patch channel for an off-store app. No change may break the version-check/update path of already-shipped clients.
18. **Failing tests fail the phase.** Never claim completion with failing tests, skipped security checklist items, or unwritten completion reports.

## Architecture & code
19. **Major architectural changes require an ADR** before implementation. Don't bypass module boundaries "temporarily".
20. **Module-owned tables.** A NestJS module touches only its own tables; cross-module access via exported services or domain events.
21. **No business logic duplicated into Flutter.** The client renders state and fires events; validation on the client is UX, and is always re-validated server-side.
22. **No premature microservices or abstractions.** Extract when pain is real; keep boundaries extraction-ready instead.
23. **API changes are additive within a version**; breaking changes get a new version plus a forced-update plan tolerant of sideload lag.
24. **Document uncertainty instead of inventing business rules** — new ambiguity goes to `open-questions.md` with options + recommendation.

## UI
25. ⛔ **No screen hardcodes styling values.** All color/typography/spacing/radius/motion flows from design tokens; all UI composes `ui_kit` components; screens are thin render-state/fire-events shells.
26. **All assets and animations go through the generated registry and intent-named wrapper widgets** (`CardDealAnimation`, …) so Rive/Lottie swaps never touch call sites.
27. **No visual polish before the designer.** Placeholder theme stays deliberately plain; design integration is its own phase (P19).

## Process
28. **Per-phase workflow is mandatory** (see `CLAUDE.md`): read docs → inspect code → verify previous phase → plan from template → implement approved scope only → test/lint/analyze → security checklist → update docs + `progress.md` → completion report → stop.
29. **Docs stay in sync** with architectural change in the same PR; `progress.md` and the UI flow map are living documents.
30. **Correctness and security over speed**, in every conflict.
