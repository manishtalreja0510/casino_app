# ADR-021 — Local-first, zero-cost development environment

**Status:** ACCEPTED
**Date:** 2026-08-23
**Related:** OQ-06 (decided), ADR-011 (secrets/config), ADR-012 (environments & flavors), P0, P1

## Context

OQ-06 confirmed AWS + AWS Secrets Manager as the eventual hosting and secrets target, with an explicit owner mandate: **for the whole development period the stack must run free on localhost** — no cloud account, no cloud spend, no managed service required to develop, run, or test the platform.

This is not merely a cost preference. A stack that only works against cloud infrastructure couples every developer (and CI) to provisioning, credentials, and network availability, and makes the "no secrets in repo" rule (rule 14) harder to honour because people start pasting real credentials locally to get unblocked.

## Decision

1. **The full backend stack runs locally with one command and no external accounts.** Dependencies are PostgreSQL and Redis only, both free and locally runnable.
2. **Primary local path: Docker Compose** (`infra/docker-compose.dev.yml`) providing Postgres 16 + Redis 7 on fixed local ports with throwaway credentials.
3. **Documented fallback: native services** (`scripts/dev-services.sh`) for environments where the Docker daemon is unavailable — the API must not care which path provided the ports.
4. **The `dev` environment uses no secret manager.** Config comes from a gitignored `.env` seeded from committed `.env.example` files containing only non-secret local defaults. AWS Secrets Manager applies to `staging`/`prod` only (ADR-011), and nothing in the code may hard-depend on it.
5. **No cloud SDK is required at runtime in dev.** Provider-specific integrations sit behind ports with local/fake adapters selected by config, so a developer can run everything offline.
6. **CI runs the same local-first path** (service containers / native services), never cloud resources — keeping CI free and hermetic.
7. **Cloud provisioning requires explicit approval.** Until then, no Terraform apply, no managed resources, no billing-attached accounts.

## Alternatives considered

- **Develop directly against shared cloud dev infrastructure.** Rejected: recurring cost from day one, credential sprawl, developers blocked by network/provisioning, and it contradicts the owner mandate.
- **SQLite/in-memory substitutes for local dev.** Rejected outright: the ledger depends on PostgreSQL semantics (row locking, deferred constraints, transactional guarantees — ADR-004/ADR-008). Testing money paths against a different engine would be testing a different system.
- **Docker-only, no native fallback.** Rejected: the Docker daemon is not always available (this very container has it installed but not running); a documented fallback keeps the team unblocked.
- **Devcontainer/Nix as the mandated path.** Deferred: useful, but an extra abstraction to maintain before it has earned its place. The compose file plus a script is enough today.

## Consequences

**Positive.** Zero cost during development; onboarding is `pnpm install` + one compose command; CI is hermetic and free; offline work is possible; no temptation to place real credentials on laptops.

**Negative / accepted.** Local Postgres and Redis are single-node, so behaviours that only appear in managed multi-node setups (failover, replica lag, ElastiCache quirks) are not exercised locally — they are exercised in `staging`, which mirrors prod topology (ADR-012), and in the P14 chaos/load phase. Local performance numbers are not predictive; capacity conclusions come only from staging load tests.

**Deliberate limit.** "Runs free locally" applies to development and CI. It is not a claim that production will be self-hosted — production targets AWS per ADR-011.
