# ADR-012: Environment & Flavor Strategy

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

A real-money platform cannot risk cross-environment contamination: test data touching prod money paths, a dev key signing a prod build, or security machinery (WAF, pinning, forced update) meeting production traffic untested. We need an environment model that matches the Flutter flavor system and stays honest about isolation.

## Decision

Three environments — **dev / staging / prod** — fully isolated: separate data stores, separate secrets (own secret-manager scope per ADR-011), separate infrastructure, no shared services.

- **Flutter flavors** `dev` / `staging` / `prod` map 1:1 to backend environments: applicationId suffixes (`.dev`, `.stg`), distinct names/icons/endpoints via per-flavor `--dart-define-from-file`, side-by-side installable. Separate Firebase-or-similar projects if used.
- **Separate signing keys per flavor.** The prod signing key is critical infrastructure for an off-store app (it *is* user trust — Android update semantics bind to it): offline/HSM custody, documented access procedure. Dev/staging keys are ordinary CI-managed keys.
- **Staging mirrors prod topology**, including WAF/CDN front and certificate pinning with **its own pins** — pin rotation, forced update, and kill-switches are drilled in staging before they ever run in prod (rules 16, 17).
- **Synthetic data only outside prod.** No prod data copies into dev/staging, ever; seeders generate test users/games/ledgers.
- Config matrix documented in `docs/07-operations/environments-and-flavors.md`.

## Alternatives considered

- **Shared staging/dev infrastructure** (one cluster, namespaced) — cheaper, but a single blast radius for secrets and data, and "isolation" becomes a config claim instead of a fact; rejected for a money-handling system.
- **Two environments (dev + prod)** — leaves nowhere to test pin rotation, forced update, WAF rules, or migrations against prod-shaped topology before prod; rejected.
- **Backend environment per developer** — nice ergonomics, real cost and drift; local docker-compose (PG+Redis) covers the need. Revisit only if local dev provably bottlenecks.

## Consequences

- Three sets of infra cost; accepted — staging is deliberately prod-shaped, not a toy.
- Pinning/WAF/update failures are caught pre-prod; a botched pin rotation bricks staging installs, not users.
- Prod key custody adds ceremony to release signing; that friction is the point.
- Synthetic-data rule means investing in good seeders; also removes the largest PII-leak vector.

## Links

- ../07-operations/environments-and-flavors.md, ../01-architecture/infrastructure-architecture.md
- ../00-project/system-rules.md (rules 14, 16, 17)
- ADR-011-secrets-and-configuration-management.md, ADR-013-network-security-model.md, ADR-017-offstore-distribution-and-forced-update.md · Phases: P0, P2, P13
