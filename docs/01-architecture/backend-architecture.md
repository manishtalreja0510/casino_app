# Backend Architecture

The NestJS modular monolith (`apps/api`). This doc defines module boundaries, internal layering, data access, cross-cutting frameworks (config, errors, flags, jobs, events), and the deployment shape. System-level context: `system-architecture.md`. Database detail: `database-architecture.md`. Security detail: `security-architecture.md` and `docs/04-security/*`.

## 1. Why a modular monolith (ADR-003)

**Problem.** A small team must ship auth, money, real-time gameplay, and compliance surfaces with high correctness requirements, while keeping a path to independent scaling of hot components (realtime, engine, risk) later.

**Chosen approach.** One NestJS process type (single container image, role-flagged — §12), internally partitioned into strictly bounded domain modules that behave like services-in-one-process: own tables, exported service interfaces, in-process domain events.

**Alternatives considered.**
- *Microservices from day one* — rejected: distributed transactions across a financial ledger, N deploy pipelines, and network-partition failure modes for a team that doesn't yet have the load to justify any of it.
- *Unstructured monolith* — rejected: money code and game code sharing tables becomes un-extractable and un-auditable within months.
- *Serverless/functions* — rejected: persistent WebSocket state and turn timers fit poorly; cold starts hurt gameplay latency.

**Why.** All financial invariants live in one PostgreSQL transaction scope; one deploy artifact; refactoring across boundaries is a compiler-checked change, not a cross-repo migration.

**Trade-offs accepted.** One runtime blast radius (mitigated by role-split deploys and kill-switches); discipline is enforced by convention + review rather than a network boundary (system rule 20); a hot module can't be scaled alone until extracted — the seams (§3) make extraction a deployment change, not a rewrite.

## 2. Module map (canonical — matches `system-architecture.md §1`)

| Module | Owns | Notes |
|---|---|---|
| `auth` | credentials, tokens, refresh families, device keys, WS tickets | ADR-013; `docs/04-security/authentication-security.md` |
| `users` | user profile, account states (active/suspended/self-excluded/closed) | |
| `kyc` | KYC levels, verification attempts | `KycProviderPort` adapter (OQ-03, ADR-015) |
| `wallet` | **the ledger**: accounts, transactions, entries, balances | sole writer of ledger tables (ADR-008) |
| `payments` | deposit/withdrawal state machines, PSP webhook records | `PaymentProviderPort` (OQ-02, ADR-014); talks to `wallet` via service, never tables |
| `game-engine` | match lifecycle, `game_events`, `game_snapshots`, RNG service, settlement orchestration | contract runtime (ADR-006/009) |
| `games/*` | per-game modules (`games/poker`, `games/casino-game-1`) | pure `GameDefinition` implementations; **no DB tables of their own beyond game-config; never touch wallet** (rule 10) |
| `game-sessions` | player↔match participation records, session queries | |
| `matchmaking` | match formation audit records | live queues in Redis |
| `realtime` | Socket.IO gateways, rooms, seq/resume protocol | no domain tables; ADR-007 |
| `risk` | signals, rules, scores, review cases | ADR-018 |
| `responsible-gaming` | limits, self-exclusion, reality checks, cool-off | |
| `notifications` | templates, prefs, inbox, transport ports (OQ-09) | |
| `audit` | append-only hash-chained `audit_log` | write-only service exported to all |
| `admin` | admin users, roles, admin audit | guards: TOTP 2FA, RBAC, IP allowlist |
| `platform` | config, feature flags, kill-switches, health, min-version policy | |
| `jobs` | BullMQ queue registration, worker bootstrap | job *classes* live in owning domain modules |

## 3. Module boundary rules (normative; system rules 19–22)

1. **Own tables only.** A module reads/writes only tables in its own schema (`database-architecture.md §2`). No cross-module joins in application queries. Exception: explicitly exported read models (e.g. `wallet` exposes a balance view service, not its tables).
2. **Cross-module calls go through exported services.** Each module's `index.ts` exports a small, intentional service surface; everything else is module-private. Importing another module's repository or internal service is a review-blocking violation.
3. **Domain events for decoupled reactions.** In-process, typed, emitted after commit (§10). `risk`, `audit`, `notifications` are primarily event consumers — domain modules never import them for control flow (audit writes on money paths are the exception: synchronous, same transaction).
4. **Extraction-ready seams.** Every boundary must survive becoming a network boundary: DTOs (from `packages/contracts`) at the surface, no shared mutable state, no leaked Drizzle entities, events carry full payloads (no "call me back for details").
5. **Hard rule:** `games/*` modules never import `wallet`. Settlement flows exclusively `game-engine` → `wallet` domain service, idempotent by match id (rule 10).

Enforced by: ESLint `no-restricted-imports` boundaries config per module, review checklist, and (P14) an automated dependency-graph check in CI.

## 4. Layering within a module

```
controller / gateway      HTTP (REST) or Socket.IO surface. Zero business logic.
        │                 Validates via contract schemas, maps to/from DTOs.
        ▼
service(s)                Domain logic, transactions, invariants, domain events.
        │                 The exported surface lives here.
        ▼
repository                Drizzle queries + raw SQL. Only layer touching the DB.
```

- Controllers/gateways are thin adapters; anything testable without HTTP lives in services.
- Repositories return domain types, not Drizzle row types, at the module surface.
- Transaction boundaries are owned by services (a repository never opens/commits its own transaction), so multi-repository units of work within a module stay atomic.

## 5. Data access (ADR-020)

**Problem.** We need typed queries for productivity, but the ledger and game-event paths demand hand-auditable SQL, DB-enforced constraints, and migrations a reviewer can read line-by-line.

**Chosen.** Drizzle ORM with `drizzle-kit`-generated SQL migrations, **hand-reviewed and hand-edited** before merge (SQL is the artifact of record, not the TS schema). Raw SQL (via Drizzle's `sql` template) is **mandatory** on ledger-critical paths: ledger inserts, balance updates with `SELECT ... FOR UPDATE`, reconciliation queries, append-only trigger DDL.

**Alternatives.**
- *Prisma* — rejected: migration engine and query planner are opaque where we most need transparency; historically weak `FOR UPDATE`/advisory-lock ergonomics; runs its own query engine layer.
- *TypeORM* — rejected: ActiveRecord/decorator magic, long-standing correctness edge cases, weak migration review story.
- *MikroORM* — solid unit-of-work, but the identity-map abstraction works against explicit transaction/locking control on money paths.
- *Kysely* — closest second (pure query builder); Drizzle chosen for schema-as-code that still emits reviewable SQL migrations and lighter per-query ceremony.

**Trade-offs.** Drizzle is younger than Prisma/TypeORM; we mitigate by keeping the SQL-first migration discipline (we own the SQL) and by constraint tests (pgTAP-style, optional per ADR-020) proving DB-level invariants independent of the ORM.

Migration policy detail: `database-architecture.md §8`.

## 6. Configuration module (`platform`)

- All env config declared in one schema (zod), validated at bootstrap; **fail-fast**: missing/invalid config aborts startup with a named-key error (value never logged).
- Typed `ConfigService` injected everywhere; no `process.env` reads outside the config module (lint-enforced).
- Secrets arrive as env vars injected at deploy from the secret manager (OQ-06, ADR-011); the app cannot tell secret from non-secret config and treats all values as unloggable.
- Per-env behavior (dev/staging/prod) keyed by a single `APP_ENV`; no `if (dev)` scattering — capabilities expressed as config values.

## 7. Error model

- Domain code throws **typed domain errors** (`InsufficientFundsError`, `MatchNotJoinableError`, …), each mapped to a stable contract error code defined in `packages/contracts` (single registry, shared with the Flutter client).
- A global exception filter converts to the JSON error envelope (`docs/03-api/api-conventions.md`): `{ error: { code, message, details?, traceId } }`. Unknown exceptions → `INTERNAL` with no internals leaked; full detail goes to logs/Sentry keyed by `traceId`.
- WS errors use the same code registry inside the versioned event envelope.
- Error messages are developer/user-safe by construction: no SQL, no stack, no PII (rule 15).

## 8. Feature flags & kill-switches (`platform`)

- **Truth in PG** (`platform.feature_flags`: key, value, updated_by, updated_at, four-eyes fields where required), **cache in Redis** (short TTL, invalidated on write via pub/sub).
- **Fail-closed:** cache miss + DB unreachable ⇒ flag evaluates to its safe default — for kill-switches and `compliance.real_money_enabled`, that default is OFF/blocked. A flag lookup can degrade availability, never safety.
- Kill-switch classes: global maintenance (503 envelope + WS drain), per-game, per-feature, real-money master gate (default OFF, admin four-eyes change — rule 11).
- Every flag change is audit-logged and emits a domain event (risk/ops dashboards; kill-switch activation pages a human per `system-architecture.md §6`).
- Until P12 (admin UI), flags are changed via migration/CLI with the same audit path.

## 9. Background jobs (BullMQ, `jobs` + owning modules)

- BullMQ (Redis) provides scheduling, retries with backoff, delayed jobs (turn timers via the P5 timer framework), and competing consumers. Redis is orchestration only: **financial/game state machines are rows in PG; jobs only drive transitions** (rule 7 corollary).
- **Every job idempotent**: job payload carries the PG state-machine id; the handler re-reads state, no-ops if the transition already happened, and uses the same idempotency keys as the interactive path.
- Job classes are declared in the owning domain module (e.g. `payments.WithdrawalPayoutJob`, `wallet.ReconciliationJob`, `game-engine.TurnTimeoutJob`); the `jobs` module owns queue wiring, worker bootstrap, and dead-letter handling (DLQ entries page or land in an ops review queue).
- Reconciliation jobs (rule 9) are jobs like any other, but their failure/drift path pages a human and freezes scope — never auto-corrects.

## 10. Domain events

- **Now:** in-process, typed event bus (contract-versioned payloads from `packages/contracts`), emitted **after transaction commit** to avoid phantom events; handlers are isolated (one failing handler never rolls back the producer or blocks siblings) and must be idempotent.
- **Later (extraction readiness):** the emit call sits behind an `EventPublisher` interface whose second implementation is a transactional **outbox** (event row written in the producing transaction, relayed by a `jobs` worker). We do not build the outbox until an extraction or an at-least-once external consumer requires it — but events are shaped for it from day one: self-contained payload, event id (UUIDv7), occurred_at, version.

## 11. Request lifecycle

```
LB/WAF → Nest middleware (traceId, pino ctx, body limits)
       → Guards: auth (JWT) → device binding/request signature (financial endpoints)
                → rate-limit class → flag/kill-switch gate → RBAC (admin)
       → Interceptors: audit context, timing metrics, idempotency-key handling
       → Validation: request schema from packages/contracts (single source; client uses the same)
       → Controller → Service (transaction) → response envelope
```

- Validation uses the contract JSON Schemas — the API can never drift from the published contract because they are the same artifact.
- `Idempotency-Key` handling for mutating REST endpoints is a shared interceptor backed by a PG uniqueness check in the owning domain (the ledger's `idempotency_key` for money ops).
- WS lifecycle mirrors this in `realtime` gateways: ticket auth at handshake, per-event schema validation, per-room seq stamping (`realtime-architecture.md`).

## 12. Observability

- **pino** structured JSON, one logger per request/job carrying `traceId`, `userId` (UUID only), module, and event fields. No PII/secrets ever (rule 15); serializer allowlists tested in CI (P1).
- **OpenTelemetry** traces (HTTP, WS event handling, PG, Redis, BullMQ spans) and metrics → Prometheus/Grafana/Loki, errors → Sentry (OQ-10).
- `traceId` is returned in every error envelope, closing the loop from a user report to a trace.
- Domain metrics emitted at service layer: ledger op latency/failure, settlement duration, reconciliation drift (gauge that should be 0), WS connect/resume rates, flag evaluation fallbacks.

## 13. Testing seams (ADR-010)

- Services take dependencies via Nest DI → unit tests with in-memory fakes; ports (`PaymentProviderPort`, `KycProviderPort`, `RngService`, notification transports) each ship a deterministic fake used in tests and dev.
- Integration: Testcontainers (PG+Redis) + supertest against the real module graph; constraint tests hit PG directly (append-only, zero-sum, CHECK).
- The contract conformance suite (P6) runs any `GameDefinition` against the engine.
- Socket.IO harness + k6 for realtime/load (seeded in P5, exercised in P14).

## 14. Deployment shape

Single container image; `ROLE` env selects the process profile:

| Role | Runs | Notes |
|---|---|---|
| `api` | HTTP + WS gateways; no BullMQ workers | horizontally scaled behind LB |
| `worker` | BullMQ workers, schedulers, reconciliation | scaled independently of request traffic |
| `all-in-one` | everything | dev / small envs |

One image ⇒ api and workers can never skew versions within a deploy; role split ⇒ a settlement burst can't starve request latency, and it rehearses the future service extraction. Infra detail: `infrastructure-architecture.md`.
