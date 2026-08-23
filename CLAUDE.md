# CLAUDE.md — casino_app

Real-money real-time gaming platform. Flutter (Android, off-store APK) + NestJS modular monolith (monorepo) + PostgreSQL (sole source of truth) + Redis (never financial truth) + Socket.IO. Currently in planning: **no application code exists yet**; docs are the foundation. Start at `docs/MASTER_ROADMAP.md` and `docs/progress.md`.

## Non-negotiable rules (full list: `docs/00-project/system-rules.md`)
1. The client is always untrusted; the server is authoritative for all outcomes, balances, timers, and hidden information. Never trust client-provided financial or game-state values.
2. Money = integer minor units in a double-entry, append-only ledger in PostgreSQL. Balances are derived views. No floats. No UPDATE/DELETE on ledger rows — corrections are reversals.
3. Every financial operation is atomic, concurrency-safe, and idempotent. External callbacks (PSP/KYC) are idempotent and signature-verified. Redis never holds financial truth.
4. No secrets in code, repo, git history, or binary — ever. Client config via gitignored `--dart-define-from-file` files; backend secrets from the secret manager; only `.example` templates are committed.
5. Every sensitive action (money, auth, admin) is audit-logged immutably. No PII or secrets in logs.
6. Every game implements the standard `GameDefinition` contract and never touches wallets/ledger outside game-engine → wallet domain services.
7. Real-money paths stay behind `compliance.real_money_enabled` (default OFF) until jurisdiction/PSP/KYC decisions (OQ-01/02/03) close. Development runs on test currency.
8. Server-side kill-switches (global + per-game) and forced client update must always work.
9. No screen hardcodes styling — design tokens + `ui_kit` only; assets/animations via the generated registry and intent-named wrappers.
10. Major architectural changes require an ADR (`docs/decisions/`). Don't bypass module boundaries; modules touch only their own tables.
11. Ambiguity → record in `docs/00-project/open-questions.md` (options + recommendation); never invent business rules or silently pick providers/jurisdictions/vendors.
12. Correctness and security over speed. No premature microservices/abstractions. No business logic duplicated into Flutter. Never claim completion with failing tests.

## Mandatory per-phase workflow
1. Read the relevant `docs/01-architecture/` + `docs/02-domains/` docs for the phase.
2. Inspect current code; **verify** (don't assume) the previous phase's completion state.
3. Write/update the phase plan from `docs/phases/PHASE_TEMPLATE.md`; validate it against the architecture docs before implementing.
4. Implement only approved scope — no silent expansion.
5. Add/run tests, linting, static analysis; keep existing suites green.
6. Run `docs/04-security/security-checklist.md` for sensitive changes (security section is mandatory in every phase plan).
7. Update affected docs, `docs/progress.md`, and `docs/08-design/ui-flow-map.md` (if UI changed) in the same change.
8. Write the completion report in the phase doc. **Stop — never auto-start the next phase.**

## Where things are
- Roadmap & phase gates: `docs/MASTER_ROADMAP.md` · status: `docs/progress.md`
- Open questions (OQ-nn): `docs/00-project/open-questions.md` — OQ-01 (jurisdiction/licensing) blocks all real-money work
- Architecture: `docs/01-architecture/` (start: `system-architecture.md`) · domains: `docs/02-domains/`
- API/WS conventions: `docs/03-api/` · security: `docs/04-security/` (threat model, checklist)
- Testing: `docs/05-testing/` · compliance: `docs/06-compliance/` · ops/environments/runbooks: `docs/07-operations/`
- UI strategy, tokens, flow map: `docs/08-design/` · ADRs: `docs/decisions/`
- Monorepo layout: `docs/01-architecture/system-architecture.md` §2. Canonical phase list: roadmap only — don't restate elsewhere.

Keep this file under ~150 lines; put content in `docs/`, pointers here.
