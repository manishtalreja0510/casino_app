# casino_app

Real-time, real-money gaming platform: Flutter (Android, off-store APK) + NestJS modular monolith + PostgreSQL + Redis + Socket.IO.

**Development runs entirely on test currency (`TST`).** Real-money paths sit behind the `compliance.real_money_enabled` gate, which defaults OFF. See `docs/00-project/system-rules.md` for the rules that override convenience in every trade-off.

## Quick start (free, localhost only — no cloud account needed)

```bash
pnpm bootstrap                # create local .env files from .example templates + install deps
pnpm dev:services             # start local Postgres 16 + Redis 7
                              # or: docker compose -f infra/docker-compose.dev.yml up -d
pnpm verify                   # lint + typecheck + test + build
pnpm --filter @casino/api start:dev
curl localhost:3000/api/v1/health
```

Requirements: Node 22, pnpm 10, and either Docker **or** local PostgreSQL 16 + Redis 7. Nothing else — the entire development stack is free and offline-capable (ADR-021).

## Layout

```
apps/api                  NestJS modular monolith (the backend)
apps/mobile               Flutter client — built in P2 (see its README)
apps/admin                React admin SPA — built in P12
packages/contracts        shared API/WS contracts: money, error codes, versions
infra/                    local development stack (docker compose)
scripts/                  bootstrap and local service management
docs/                     architecture, domains, security, compliance, phases
```

## Commands

| Command | Does |
|---|---|
| `pnpm verify` | lint + typecheck + test + build (what CI runs) |
| `pnpm test` | unit tests across workspaces |
| `pnpm --filter @casino/api test:e2e` | API end-to-end tests |
| `pnpm dev:services` / `:stop` / `:status` | local Postgres + Redis |
| `pnpm format` | Prettier write |

## Working on this project

Read `CLAUDE.md` first — it carries the non-negotiable rules and the mandatory per-phase workflow. Then:

1. `docs/MASTER_ROADMAP.md` — phases, gates, and what depends on what.
2. `docs/progress.md` — current status of every phase.
3. `docs/00-project/open-questions.md` — every undecided item (OQ-nn). Never invent a business rule; record it here instead.
4. `docs/phases/PHASE_TEMPLATE.md` — every phase gets a plan from this template **before** implementation.

Some rules worth knowing before your first commit:

- **No secrets in code, repo, git history, or the APK — ever.** Only `.example` templates are committed; real `.env` files are gitignored. gitleaks runs in CI.
- **Money is integer minor units in a double-entry, append-only ledger.** No floats, anywhere.
- **The client is untrusted.** The server is authoritative for every outcome, balance, timer, and piece of hidden information.
- **No screen hardcodes styling** — design tokens and `ui_kit` only.
