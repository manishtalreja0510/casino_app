# Phase 00 — Foundations

## 1. Phase overview
The monorepo and its rails: workspace tooling, TypeScript baselines, shared contracts package, a minimal NestJS API that answers a health check, the mobile/admin workspace skeletons, a **free localhost dev stack**, CI, and secrets hygiene. Roadmap entry: `../MASTER_ROADMAP.md` §P0. Nothing in this phase is a product feature — it exists so that P1+ never has to retrofit tooling, config discipline, or CI.

## 2. Current status
`COMPLETE` — 2026-08-23. Mirrored in `../progress.md`.

## 3. Objective
A fresh clone can be bootstrapped and verified with documented commands, entirely offline-capable and at zero cost, with CI enforcing lint/typecheck/test/build and secret scanning on every push.

## 4. Dependencies
None (first phase). Owner decisions applied: OQ-06 → AWS target **with local-first mandate** (ADR-021) directly shapes this phase's dev-stack work.

## 5. Preconditions
Node 22 LTS, pnpm 10, git. Docker optional (native Postgres/Redis fallback documented). Verified in this environment: Node v22.22.2, pnpm 10.33.0, Postgres 16 + Redis 7 installed natively, Docker daemon **not** running → the native fallback path is not theoretical, it is the path used here.

## 6. Existing-code analysis
Repository contained documentation only (84 markdown files, no application code, no package manifests). Nothing to preserve or migrate; no previous phase to verify.

## 7. Scope
1. pnpm workspaces + Turborepo task graph; pinned Node/pnpm versions.
2. Shared TypeScript baseline (`tsconfig.base.json`), Prettier, ESLint 9 flat config.
3. `packages/contracts` — the contract-first seed: API version constant, `Money` type (integer minor units), canonical error-code namespaces, health-response type, plus tests asserting the money/error invariants.
4. `apps/api` — NestJS skeleton: env-schema-validated config, `/api/v1/health` + `/api/v1/health/ready`, error envelope shape from contracts, unit + e2e tests.
5. `apps/mobile`, `apps/admin` — workspace skeletons with READMEs stating what P2/P12 will build (see §23).
6. **Local-first dev stack**: `infra/docker-compose.dev.yml` (Postgres 16 + Redis 7) and `scripts/dev-services.sh` native fallback; both expose identical ports so the API is indifferent to which is used.
7. Env scaffolding: committed `.env.example` files only; real `.env` gitignored (rule 14).
8. CI (GitHub Actions): install → lint → typecheck → test → build, plus gitleaks secret scanning.
9. Contributor `README.md` with the bootstrap path, and a PR template pointing at the security checklist.

## 8. Out of scope
Database wiring, migrations, Redis clients, logging/OTel, feature flags, audit log (**all P1**). Flutter application code and its CI lane (**P2** — see §23). Admin SPA (**P12**). Any cloud provisioning (blocked pending explicit approval, ADR-021). Any domain, money, or game logic.

## 9. Architecture considerations
Layout follows `../01-architecture/system-architecture.md` §2 exactly. Contracts are authored once in `packages/contracts` and consumed by the API — the Dart generation step arrives in P2. No new ADR required; this phase *implements* ADR-001 (monorepo), ADR-021 (local-first), and the config half of ADR-011.

## 10. Database changes
None. The compose/native stack provisions an empty `casino_dev` database for P1 to migrate into; no schema is created in this phase.

## 11. Backend changes
New `apps/api`: `AppModule`, `ConfigModule` (zod-validated environment, fail-fast on invalid config), `HealthModule`. Global `/api/v1` prefix. No persistence, no auth, no domain modules.

## 12. Flutter changes
Workspace skeleton only — see §23 for why no Dart source is written in this phase.

## 13. API changes
`GET /api/v1/health` (liveness: status, version, uptime) and `GET /api/v1/health/ready` (readiness; returns `ok` with no dependencies to check until P1 adds them). Response shapes exported from `packages/contracts`.

## 14. WebSocket changes
None (P5).

## 15. Security considerations (MANDATORY)
- **Secrets (rule 14):** no secret is created, committed, or required by this phase. Only `.env.example` files with non-secret local defaults are committed; `.env`, `*.local`, keystores, and `--dart-define` env files are gitignored. gitleaks runs in CI on every push.
- **Config discipline:** the API refuses to boot on invalid/missing config rather than falling back to defaults silently — fail-fast is the security-relevant behaviour (a mis-set environment must not quietly run as `dev`).
- **Local credentials:** the dev stack uses obviously-local throwaway credentials on loopback only; documented as such so nobody mistakes them for a template for real environments.
- **No PII/secret logging:** nothing in this phase logs request bodies; the pino/scrubbing baseline lands in P1.
- **Dependency surface:** kept minimal and lockfile-pinned; CI runs an audit.
- **Checklist:** `../04-security/security-checklist.md` §A items applicable to a no-endpoint-auth phase; §D "no secrets in binary" is deferred to P2 with the Flutter build.

## 16. Edge cases
Missing/invalid env vars (must fail fast with a readable message); Docker unavailable (native fallback must work — exercised here); port collisions (documented override via env); fresh clone with no `.env` (bootstrap script copies from `.example`); CI cold cache; pnpm version drift (pinned via `packageManager`).

## 17. Testing strategy
- `packages/contracts`: unit tests for money-shape and error-code invariants.
- `apps/api`: unit test for the health service; e2e (supertest) asserting both health endpoints and the `/api/v1` prefix; a config test asserting the app **refuses to start** on invalid config.
- Pass criteria: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all green locally and in CI.

## 18. Implementation plan
Root tooling → contracts → api → dev stack + env scaffolding → CI → README/PR template → full verification run.

## 19. Rollback / recovery
Entirely additive; no migrations, no data, no deploys. Rollback = revert the commit. The dev stack is disposable (`docker compose down -v` / drop the local database).

## 20. Acceptance criteria
1. `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm typecheck` succeed from a clean clone.
2. The API boots and `/api/v1/health` returns a well-formed response.
3. The API exits non-zero with a clear message when required config is invalid.
4. The dev stack starts free on localhost via **either** Docker Compose or the native script, with no cloud account.
5. No secret material is present in the repository (gitleaks clean).
6. CI runs the same commands as a developer does.

## 21. Definition of done
Acceptance criteria met · tests green with no skips · lint/typecheck clean · security checklist §A closed · docs + `progress.md` updated · completion report written (§22) · no untracked TODOs.

## 22. Completion report

**Delivered as planned.** Monorepo (pnpm workspaces + Turborepo, Node 22 / pnpm 10 pinned), shared TypeScript/Prettier/ESLint-9 baselines, `@casino/contracts` (API constants, `Money`, error codes, health types), `@casino/api` (NestJS 11, zod-validated fail-fast config, `/api/v1/health` + `/health/ready`), the local-first dev stack, env scaffolding, CI, README, and PR template.

**Deviations from the plan.**
1. *Global `ValidationPipe` removed from scope.* The initial `main.ts` installed one, which crashed the real boot: `class-validator` is not a dependency. Rather than add it, it was removed — validation is contract-schema-driven per `../03-api/api-principles.md`, so pulling in a decorator-based validator would have committed us to the wrong approach. P1 adds the contract-schema pipe.
2. *`src/app.setup.ts` added (not in the plan).* The bug above passed the e2e suite, because the test configured its own app differently from `main.ts`. Both now call one `configureApp()`, so test and runtime wiring cannot drift. This is the more valuable outcome of the phase's verification step.
3. *Turbo `test` outputs key removed* — no coverage artifacts are produced yet, and the stale key emitted warnings.

**Test evidence.** 23 tests green, no skips: contracts 11 (money integer-only invariants incl. float/NaN/Infinity/unsafe-integer rejection, cross-currency guard, frozen values; error-envelope shape and code uniqueness), api unit 9 (env validation incl. fail-fast on bad enum/port, datastore requirement outside dev, and that error messages never echo the offending value), api e2e 3 (both health endpoints, and 404 outside the versioned prefix). `pnpm lint`, `pnpm typecheck`, `pnpm build` clean.

**Runtime verification (not just tests).** The built API was started as a real process: `GET /api/v1/health` → `{"status":"ok","version":"0.0.0","environment":"dev","uptimeSeconds":0}`, `GET /api/v1/health/ready` → `{"status":"ok","dependencies":[]}`, `GET /health` → 404. Invalid config (`APP_ENV=not-a-real-env`) exits **1** with `Invalid environment configuration — APP_ENV: ...` and no value echoed. The **native fallback** path of the dev stack was exercised (the Docker daemon is unavailable here): Postgres 16 and Redis 7 came up on loopback, role/database were provisioned idempotently, and both were probed successfully with `psql` and `redis-cli`. Zero cloud resources, zero cost.

**CI.** First run on this branch was green across all three jobs — `Lint, typecheck, test, build` (including the API e2e step), `Secret scanning (rule 14)` with gitleaks clean, and `Dependency audit` at high severity. Run: `actions/runs/32640843321`.

**Secret hygiene.** Two `.env.example` templates tracked; the generated `.env` files are gitignored and confirmed untracked. No keystores, keys, or credentials in the tree.

## 23. Known limitations
**Flutter is not installed in this environment** (no `flutter`/`dart` binary). Writing Dart source here would produce code that cannot be compiled, analysed, or tested — which would violate the rule against claiming completion on unverified work. Therefore `apps/mobile` ships as a workspace skeleton with a README only, and the **entire Flutter toolchain — app scaffold, flavors, `ui_kit`, asset registry, router, and the mobile CI lane — is verified and delivered in P2**, where a Flutter SDK is a stated precondition. The P0 acceptance criterion "empty shell compiles per flavor" is explicitly deferred to P2 rather than asserted unverified.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Mobile scaffold + CI lane deferred | P0 does not prove the Flutter half of the layout | P2 (precondition: Flutter SDK) |
| No dependency-vulnerability policy beyond `pnpm audit` | Low now, matters as deps grow | P14 |
| Turborepo remote cache unused (local only) | Slower CI as the repo grows | When CI time justifies it |
| ~~CI workflow unproven~~ **Resolved** — first run on this branch passed all three jobs (verify, gitleaks secret scan, dependency audit) | — | Done 2026-08-23 |
| Docker Compose path unexercised (daemon unavailable here); native fallback proven instead | Compose file is config-reviewed only | First developer with Docker, or P1 |

## 25. Next-phase dependencies
P1 inherits: the workspace layout, config-validation pattern, contracts package, error-envelope seed, dev Postgres/Redis on fixed local ports, and the CI job it extends with a database service. P2 inherits the same rails plus the `apps/mobile` slot. **Stop after this phase — P1 does not auto-start.**
