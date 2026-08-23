# System Architecture

The top-level map. Detail lives in the sibling architecture docs and `docs/02-domains/*`; decisions are justified in `docs/decisions/` (ADRs). Undecided items are referenced as OQ-nn (`docs/00-project/open-questions.md`).

## 1. Shape of the system

```
                       ┌────────────────────────────────────────────────┐
                       │                WAF / CDN / DDoS                │
                       │   (e.g. Cloudflare — origin not reachable      │
                       │    directly; TLS 1.2+/1.3 only)                │
                       └───────────────┬───────────────┬────────────────┘
   Flutter app (Android, off-store)    │ REST /api/v1  │ WebSocket (Socket.IO)
   flavors: dev / staging / prod       │               │ namespaces /lobby /game
                       ┌───────────────▼───────────────▼────────────────┐
                       │        NestJS modular monolith (apps/api)      │
                       │  auth · users · kyc · wallet · payments ·      │
                       │  game-engine · games/* · game-sessions ·       │
                       │  matchmaking · realtime · risk · resp-gaming · │
                       │  notifications · audit · admin · platform ·    │
                       │  jobs (BullMQ workers)                         │
                       └───────┬───────────────┬───────────┬────────────┘
                               │               │           │
                     ┌─────────▼───────┐ ┌─────▼─────┐ ┌───▼──────────────┐
                     │ PostgreSQL 16+  │ │ Redis 7+  │ │ External ports    │
                     │ SOLE source of  │ │ cache ·   │ │ PSP (OQ-02)       │
                     │ truth: ledger,  │ │ locks ·   │ │ KYC (OQ-03)       │
                     │ users, games,   │ │ queues ·  │ │ Push (OQ-09)      │
                     │ audit, config   │ │ rate-lim ·│ │ Email provider    │
                     └─────────────────┘ │ WS adapter│ └───────────────────┘
                                         │ hot game  │
                                         │ state     │
                                         └───────────┘
   apps/admin (React SPA, later phase) ──► admin module, same API, own auth surface
```

**One backend deployable** (modular monolith, ADR-003) scaled horizontally; Socket.IO instances coordinated through the Redis adapter (ADR-007). PostgreSQL is the only source of truth for anything persistent or financial (ADR-004); Redis is disposable infrastructure — losing it may interrupt play, never money (ADR-005).

## 2. Monorepo layout (ADR-001)

```
/apps/api                        NestJS modular monolith
/apps/mobile                     Flutter app (Android first)
/apps/mobile/packages/ui_kit     design tokens, theme, all shared widgets
/apps/mobile/packages/assets     generated asset registry + placeholder assets
/apps/mobile/packages/api_client generated REST client + WS event models
/apps/admin                      React admin SPA (built in P12; placeholder until then)
/packages/contracts              OpenAPI spec, WS event schemas, shared TS types, error codes
/tools                           codegen and scripts
/docs                            this documentation
/.github/workflows               CI (GitHub Actions)
```
pnpm workspaces + Turborepo on the TS side; melos for the Dart packages. Contracts are written once in `packages/contracts` and **generated** into the Dart `api_client` — no hand-duplicated DTOs.

## 3. Core principles (normative — see `docs/00-project/system-rules.md`)

1. **The client is compromised by definition.** The APK will be decompiled and instrumented; that cannot be prevented, only made expensive. The server is authoritative for every outcome, balance, timer, entitlement, and piece of hidden information. Client hardening raises attacker cost; it is never a security boundary.
2. **Money is integers in minor units**, in a double-entry append-only ledger in PostgreSQL (ADR-008). Balances are derived/cached views. Every financial mutation is idempotent, atomic, concurrency-safe.
3. **Games are plugins.** Every game implements one `GameDefinition` contract (ADR-009); the engine owns lifecycle, persistence, timers, RNG, and settlement. Games never touch the wallet.
4. **Redis never holds financial truth.** Ephemeral game state in Redis is an optimization over the PG event log, which is what recovery and disputes read.
5. **Real money is gated.** All real-money paths sit behind the `compliance.real_money_enabled` flag (default OFF, admin four-eyes change), blocked on OQ-01/02/03. Development runs on `TST` test credits.
6. **Placeholder-first UI.** Tokens + `ui_kit` + thin screens + asset registry make the later designer hand-off a restyle, not a rewrite (ADR-019).

## 4. Request paths

- **REST** (`/api/v1`): everything non-realtime — auth, profile, wallet views, lobby data, deposits/withdrawals, KYC. JSON envelope errors, `Idempotency-Key` on mutations, cursor pagination (`docs/03-api/api-conventions.md`).
- **WebSocket**: gameplay only. Client obtains one-time WS ticket via REST → Socket.IO handshake → rooms `user:{id}`, `table:{id}`. Server events carry per-room `seq`; reconnect resumes via replay window in Redis or full `playerView` resync (`docs/01-architecture/realtime-architecture.md`).
- **Webhooks in** (PSP, KYC): signature-verified, idempotent by provider event id, processed through orchestration state machines in PG.
- **Admin**: same API process, separate module + guards (2FA, RBAC, IP allowlist option, own audit trail).

## 5. Data responsibilities

| Concern | PostgreSQL | Redis |
|---|---|---|
| Ledger, balances, payments, KYC state | truth | — |
| Users, sessions, devices | truth | session cache |
| Game history | `game_events` + `game_snapshots` (truth) | hot state, replay ring buffer |
| Matchmaking | audit trail of matches | live queues, seat reservations |
| Feature flags / kill-switches | truth | cache (short TTL) |
| Rate limits, WS scaling, locks, jobs (BullMQ) | — | operational |
| Audit log | append-only, hash-chained | — |

## 6. Cross-cutting

- **Auth/session** — ES256 JWT access (10 min) + rotating one-time refresh tokens with reuse detection; Android Keystore device binding; signed requests on financial endpoints (ADR-013, `docs/04-security/authentication-security.md`).
- **Risk engine** — every suspicious signal (client hardening telemetry, velocity, device/IP graphs, gameplay stats) flows to `risk`, which flags/limits/freezes and feeds manual-review queues. Degrade, don't hard-block, on client-side signals.
- **Audit** — every sensitive action (money, auth, admin, game voids) appended to the immutable audit log. No PII or secrets in logs anywhere.
- **Jobs** — BullMQ on Redis for orchestration and retries; all jobs idempotent; state machines live in PG.
- **Observability** — pino structured logs, OpenTelemetry traces/metrics, Prometheus/Grafana/Loki + Sentry (OQ-10). Reconciliation drift and kill-switch activations page a human.
- **Kill-switches** — global maintenance, per-game, per-feature, real-money master gate. Forced client update (min-version policy) must always work — it is the security patch channel for an off-store app.

## 7. Environments

dev / staging / prod, fully isolated (data, secrets, infra), matching the three Flutter flavors. Staging mirrors prod topology including WAF and certificate pinning (its own pins) so security machinery is tested before prod. Config matrix: `docs/07-operations/environments-and-flavors.md`. Secrets only from the secret manager (OQ-06, ADR-011); client build config only from gitignored `--dart-define-from-file` files.

## 8. Scaling & extraction path

Start: 1 LB → N stateless API/WS containers → 1 PG primary (+ replica) + 1 Redis. Socket.IO Redis adapter makes WS horizontal; matchmaking and engine workers are competing consumers on BullMQ. The modular monolith's boundaries (module-owned tables, service interfaces, domain events) are the future service seams — extraction (likely first: realtime+engine, or risk) is a deployment change, not a rewrite. No microservices before the pain is real (ADR-003).

## 9. What is deliberately NOT here yet

Microservices, event buses (Kafka etc.), CQRS/event-sourcing outside the game event log, multi-region, Kubernetes-first ops, crypto payments, iOS. Each would add cost now for problems we don't have; ADRs record the triggers that would revisit them.
