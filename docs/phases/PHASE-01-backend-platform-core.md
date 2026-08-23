# Phase 01 — Backend platform core

## 1. Phase overview
The NestJS chassis every domain module plugs into: data access, error model, logging, health, feature flags and kill-switches, the audit-log foundation, background jobs, and rate limiting. Roadmap entry: `../MASTER_ROADMAP.md` §P1. No domain logic ships here — this phase exists so that auth (P3), wallet (P4), and everything after plug into rails that already enforce the system rules.

## 2. Current status
`COMPLETE` — 2026-08-23. Mirrored in `../progress.md`.

## 3. Objective
A backend where: a module can be added by following one documented template; every error leaves as the contract envelope; every sensitive action can be audit-logged immutably; kill-switches and the real-money gate exist and fail closed; and PostgreSQL/Redis are wired, migrated, and health-checked.

## 4. Dependencies
P0 (COMPLETE, verified: `pnpm verify` green, CI green on run 32640843321). ADR-020 (Drizzle + SQL-first migrations), ADR-021 (local-first), ADR-005 (Redis limits), ADR-004 (PG as truth).

## 5. Preconditions
Local Postgres 16 + Redis 7 reachable on the ports from `.env` (`pnpm dev:services` or the compose file). Verified present in this environment.

## 6. Existing-code analysis
P0 delivered: workspace tooling, `@casino/contracts` (money, error codes, health types, API constants), `@casino/api` with zod-validated fail-fast config, `configureApp()` shared by `main.ts` and e2e, and health endpoints with **no** dependency checks. P1 extends exactly these seams: `configureApp()` gains the global filter/middleware, `HealthService` gains real dependency probes, `envSchema` promotes `DATABASE_URL`/`REDIS_URL` from optional-in-dev to required-everywhere.

## 7. Scope
1. **Database module** — `pg` pool + Drizzle, SQL-first migrations with a runner, per-schema layout (`platform`, `audit`), transaction helper exposing `SELECT … FOR UPDATE`-friendly access for P4.
2. **Redis module** — ioredis client with lifecycle management, used by flags cache, rate limiter, and BullMQ.
3. **Error model** — typed `DomainError` base mapping to contract `ErrorCode`s; global exception filter emitting `{ error: { code, message, details?, traceId } }`; unknown errors → `INTERNAL` with nothing leaked.
4. **Logging** — pino with **redaction** of credential/PII-shaped fields, request-scoped `traceId` propagated into the envelope and logs.
5. **Health/readiness** — liveness unchanged; readiness now probes PG and Redis and reports per-dependency status.
6. **Feature flags & kill-switches** — `platform.feature_flags` in PG, Redis cache with short TTL and invalidation, **fail-closed** evaluation, seeded with `compliance.real_money_enabled=false` and `platform.maintenance_mode=false`; per-game kill-switch key convention.
7. **Maintenance mode** — middleware returning the 503 `MAINTENANCE` envelope, with health endpoints exempt so orchestrators can still probe.
8. **Audit log** — `audit.audit_log` append-only + hash-chained, DB-level UPDATE/DELETE rejection (trigger **and** revoked privileges), writer service that participates in the caller's transaction, and a chain-verification service.
9. **Background jobs** — BullMQ queue registration + worker bootstrap + DLQ convention; no domain jobs yet.
10. **Rate limiting** — Redis token-bucket guard with per-endpoint-class configuration; applied conservatively (health exempt).
11. **Module template** — documented, with the boundary rules enforced by ESLint `no-restricted-imports`.

## 8. Out of scope
Any domain logic (auth, wallet, games). Admin UI for flags (P12 — until then flags change by migration/CLI, same audit path). OTel exporters wired to a backend (baseline only; collector choice is OQ-10). WS/Socket.IO (P5). Reconciliation jobs (P4). Four-eyes enforcement UI (P12) — the DB fields exist now.

## 9. Architecture considerations
Follows `../01-architecture/backend-architecture.md` §3 (boundary rules), §7 (error model), §8 (flags), §9 (jobs) and `../01-architecture/database-architecture.md` §2/§6 (schema ownership, audit chain). No new ADR: this implements existing ones. One deviation is recorded in §17 (integration testing without Docker).

## 10. Database changes
Migration `0001_platform_audit.sql`, forward-only with a documented rollback:
- `CREATE SCHEMA platform; CREATE SCHEMA audit;`
- `platform.feature_flags` — key PK, `value_bool`, description, `updated_by`, `updated_at`, `requires_four_eyes` flag.
- `audit.audit_log` — per `database-architecture.md` §6: `id uuid PK`, `seq bigint GENERATED ALWAYS AS IDENTITY`, `actor_type`, `actor_id`, `action`, `subject_ref`, `payload jsonb`, `prev_hash bytea`, `hash bytea`, `created_at timestamptz`.
- Append-only enforcement: `BEFORE UPDATE OR DELETE` trigger raising an exception, plus `REVOKE UPDATE, DELETE` from the application role.
- Seed rows for the two mandatory flags (both safe-default OFF).

## 11. Backend changes
New modules under `apps/api/src/platform/`: `database`, `redis`, `logging`, `errors`, `flags`, `audit`, `jobs`, `rate-limit`; `HealthModule` extended. `configureApp()` gains the exception filter and maintenance/rate-limit middleware so runtime and tests stay identical.

## 12. Flutter changes
None (P2).

## 13. API changes
No new endpoints. `GET /api/v1/health/ready` response gains populated `dependencies[]` (contract type already allows it — additive, rule 23). Error envelope now emitted for all failures.

## 14. WebSocket changes
None (P5).

## 15. Security considerations (MANDATORY)
- **Audit immutability (rule 15):** proven by tests that attempt `UPDATE` and `DELETE` and assert both are rejected at the database level, not merely by application code.
- **Hash chain:** each row hashes `prev_hash || canonical(row)`; a verification service walks the chain and detects tampering. Tested by mutating a row **as a superuser** and asserting verification fails.
- **Fail-closed flags (rule 11/16):** with Redis and PG both unreachable, `compliance.real_money_enabled` and kill-switches must evaluate to the safe value. Tested by pointing the services at dead connections.
- **Log scrubbing (rule 15):** pino redaction covers `password`, `token`, `authorization`, `refreshToken`, `secret`, `apiKey`, `cookie`, `set-cookie`, and nested request-header paths. Tested by logging a payload containing each and asserting none appear in output.
- **No internals leaked:** the exception filter never emits SQL, stack traces, or driver messages; unknown errors become `INTERNAL` plus a `traceId` that correlates to the full server-side log.
- **Least privilege:** the app role is granted DML on owned schemas only, and explicitly loses `UPDATE`/`DELETE` on the audit table.
- **Secrets:** `DATABASE_URL`/`REDIS_URL` come from env only; no credentials in code or migrations beyond the documented local-only development values.
- Checklist: `../04-security/security-checklist.md` §A in full, plus the §B items that apply to the audit foundation.

## 16. Edge cases
Database unreachable at boot (readiness red, liveness still green); Redis down (flags fall back to PG, then to safe defaults; rate limiter fails **closed** for mutations and open for health); concurrent flag writes (last-write-wins with audit trail); audit write inside a rolled-back transaction (must roll back with it — no orphan chain entries); hash chain with an empty table (genesis `prev_hash`); clock skew on `created_at`; migration run twice (idempotent, tracked); job worker started twice (BullMQ handles, DLQ documented).

## 17. Testing strategy
Unit: error mapping, flag fail-closed logic, hash computation, redaction config. Integration (real PG + Redis): migrations apply cleanly; audit append + chain verify + tamper detection + UPDATE/DELETE rejection; flag read-through cache and invalidation; readiness reporting per dependency; maintenance-mode 503 envelope.

**Deviation from `../05-testing/integration-testing.md` (Testcontainers):** Testcontainers requires a Docker daemon, which is unavailable in this environment (ADR-021 anticipated exactly this and mandated a native fallback). Integration tests therefore connect to `DATABASE_URL`/`REDIS_URL` — the local stack for developers, **service containers** in CI. The rule that money/audit paths are tested against a real PostgreSQL is fully preserved; only the container-management mechanism differs. Testcontainers can be adopted later with no test rewrites, since the tests only consume connection URLs.

## 18. Implementation plan
Migrations + runner → database/redis modules → errors + logging + filter → health probes → flags + maintenance → audit + chain verification → jobs → rate limit → module template docs → full verification.

## 19. Rollback / recovery
Additive migration; rollback = `DROP SCHEMA platform, audit CASCADE` (documented in the migration header) plus reverting the commit. No production data exists. The flags seed is safe-default OFF, so a partial rollout cannot enable real money.

## 20. Acceptance criteria
1. Migrations apply to a clean database and are idempotent on re-run.
2. `UPDATE`/`DELETE` on `audit.audit_log` are rejected by the database.
3. Audit chain verification passes on a valid chain and **fails** on a tampered row.
4. `compliance.real_money_enabled` and kill-switches evaluate to their safe value when both cache and database are unreachable.
5. Maintenance mode returns the 503 `MAINTENANCE` envelope while health endpoints keep answering.
6. `GET /api/v1/health/ready` reports per-dependency status for PG and Redis.
7. No credential/PII-shaped field appears in logs (asserted by test).
8. `pnpm verify` and the integration suite green; CI green.

## 21. Definition of done
Acceptance criteria met · tests green with no skips · lint/typecheck clean · security checklist items closed · docs + `progress.md` updated · completion report written · debt recorded.

## 22. Completion report

**Delivered as planned.** All 11 scope items: database module (pg pool + Drizzle + `withTransaction`), Redis module, SQL-first migration runner with checksummed history, error model (`DomainError` hierarchy + global filter), pino logging with redaction and per-request trace ids, readiness probes for both datastores, feature flags with fail-closed evaluation, maintenance kill-switch, hash-chained audit log with database-enforced immutability, BullMQ scaffold, Redis rate limiter, and the module template (`apps/api/src/platform/README.md`).

**Deviations from the plan.**
1. **UUIDv7 implemented in-house** (`platform/ids/uuid-v7.ts`) instead of the `uuid` package: v14 is ESM-only and a CommonJS Nest build cannot `require` it — this would have failed at runtime, not merely in tests. The implementation is ~40 lines with 8 tests covering variant bits, uniqueness, ordering, counter exhaustion, and backwards clock jumps.
2. **API "e2e" suite folded into the integration suite.** Once the app required real datastores, the P0 e2e suite and the new integration suite were the same thing under two names. One suite (`test:int`) now boots the full app against real PostgreSQL and Redis; its unique assertions were preserved. Device-level e2e begins with the Flutter client (P2+). Recorded in `../05-testing/integration-testing.md`.
3. **`DATABASE_URL`/`REDIS_URL` promoted to required in every environment**, dev included — a missing datastore now fails at boot rather than at first query. P0's config tests were updated to the new contract.
4. **CI gained PostgreSQL and Redis service containers** so integration tests run there too; still free, still no cloud resources (ADR-021).

**Three real bugs caught by running the code rather than only testing it:**
- *Maintenance-mode bypass (security-relevant).* The health exemption used `req.path`, which Express reports relative to the mount point inside middleware, so health probes were being blocked. The obvious fix — substring-matching the URL — would have let `/api/v1/wallet/debit?redirect=/health` walk straight past the kill-switch. Fixed to match the path portion of `originalUrl` against an anchored route pattern, with tests for both the exemption and the bypass attempt.
- *ESM-only `uuid`* (above), which would have broken the production boot.
- *Readiness false-negative at startup.* With the offline queue disabled (deliberate, so real traffic fails fast), ioredis rejects commands while connecting, making every instance report `degraded` for its first second. The probe now gives the connection a bounded grace before declaring Redis down.

**A flaky test was found and fixed, not tolerated.** `uuidv7` intra-millisecond monotonicity failed roughly one run in six: after the 12-bit counter overflowed, a caller-supplied fixed timestamp reset the generator's state backwards. The fix separated the two concerns — `uuidv7()` owns the monotonicity guarantee (clock-clamped, counter-overflow-safe) and is now tested on the real path with a frozen clock through two full counter exhaustions; `uuidv7At()` is stateless and documented as giving no intra-millisecond ordering. Verified stable across 8 consecutive runs.

**Test evidence.** 50 unit + 19 integration = **69 tests, no skips**, green on three consecutive runs each. Integration tests run against real PostgreSQL 16 and Redis 7. Security-critical assertions included: `UPDATE`/`DELETE` on the audit log rejected *by the database*; tampering detected by chain verification even when the trigger is disabled by a privileged actor; audit entries rolling back with their caller's transaction; chain intact under 10 concurrent appends; flags failing closed to OFF with both stores dead; no credential- or PII-shaped field surviving into a log line; the exception filter leaking neither SQL nor stack traces.

**Runtime verification.** Against a live process: `/health` and `/health/ready` (the latter reporting `postgres: ok, redis: ok`), the 404 error envelope with a trace id, the `x-trace-id` response header, and the kill-switch flipped **in the database** — normal routes returned 503 `MAINTENANCE`, health stayed 200, and `?x=/health` did not bypass it.

## 23. Known limitations
- **OpenTelemetry is not wired.** Structured logging and trace ids are in place; distributed tracing needs an exporter and a collector, and the collector choice is OQ-10. Deliberately not stubbed — a tracing setup that exports nowhere is misleading.
- **No request-validation pipe yet.** There are no request bodies to validate until P3; the pipe will be bound to contract schemas then (a decorator-based validator was explicitly not adopted — see P0's completion report).
- **Rate limiter is not yet applied to any route** (no routes need it yet) and fails **open** when Redis is down — a documented trade-off, safe only because it is defence in depth, never the control protecting money or authorisation.
- **Four-eyes approval is a database column, not an enforced flow.** `requires_four_eyes` is set on the compliance gate; enforcement arrives with the admin panel (P12). Until then flags change by migration or CLI.
- **Audit head hash is not yet exported off-system.** `AuditChainService.headHash()` exists; the write-once external export that stops a privileged attacker rebuilding the whole chain is an operational step for P14.
- **Chain verification is not scheduled.** The service exists; the periodic job lands with the reconciliation jobs in P4.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Audit chain verification is a full-window walk | Fine at current volume; O(n) as the log grows | P4 — sampled windows + head check, per the design |
| No `no-restricted-imports` boundary rules yet | Module boundaries rely on review until a second module exists | P3, when there is a boundary to enforce |
| Rate limiter is a fixed-window counter | Allows a burst at window edges | P14, against real traffic shapes |
| Per-schema database roles not provisioned | Least privilege is partly deployment-side; the audit REVOKE is in the migration | With cloud provisioning |
| Head-hash export and scheduled verification outstanding | Tamper evidence is complete only once both exist | P4 (schedule), P14 (export) |

## 25. Next-phase dependencies
P3 inherits: config, error model, logging with traceId, rate limiting, audit writer, flags. P4 inherits the transaction helper and audit-in-transaction semantics that its ledger invariants depend on. P5 inherits Redis and the jobs scaffold. **Stop after this phase.**
