# ADR-001: Monorepo architecture

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

The platform spans a NestJS backend, a Flutter app with internal packages, a later React admin SPA, shared API/WS contracts, codegen tooling, and this documentation. The client and server must agree exactly on DTOs, event schemas, and error codes — a mismatch on a money path is a production incident. We need atomic cross-cutting changes (contract + server + client in one PR), one CI story, and no drift between hand-maintained copies of the same types.

## Decision

A **single monorepo** with the canonical layout of [system-architecture.md §2](../01-architecture/system-architecture.md):

```
/apps/api            /apps/mobile (+ packages/ui_kit, assets, api_client)
/apps/admin          /packages/contracts        /tools
/docs                /.github/workflows
```

- **pnpm workspaces + Turborepo** for the TypeScript side (task orchestration, remote-cacheable builds, path-filtered CI).
- **melos** for the Dart packages under `apps/mobile`.
- **Contract-first:** `packages/contracts` holds the OpenAPI spec, WS event schemas, shared TS types, and error codes. The Dart `api_client` (REST client + WS event models) is **generated** from it via a melos/`/tools` script. Hand-duplicated DTOs are forbidden.

## Alternatives considered

- **Polyrepo (api / mobile / contracts / admin as separate repos).** Contract changes become multi-repo choreography with version-pinning ceremony; atomic changes impossible; CI and secrets config duplicated; drift between contract versions in flight is exactly the class of bug we can least afford on financial endpoints. Rejected.
- **Nx instead of pnpm + Turborepo.** Nx offers richer graph tooling but imposes its own project model and generators, and its Flutter story is third-party. pnpm workspaces are the boring standard; Turborepo adds just the caching/orchestration layer we need. Rejected as heavier than the problem.
- **No codegen — hand-kept Dart DTOs mirroring TS types.** Zero tooling cost up front, but guarantees drift as the API grows toward ~10 games with versioned WS events. A silent field mismatch in a settlement payload is unacceptable. Rejected.

## Consequences

**Positive:** atomic contract+server+client PRs; single CI pipeline with path filtering; one place for conventions, lint, and secret scanning; generated client removes an entire bug class; `/apps/admin` slots in later (P12) with zero repo ceremony.

**Negative (accepted):** two workspace tools (pnpm/Turborepo *and* melos) because Dart doesn't live in the npm graph — a `/tools` script and CI must bridge them; codegen adds a build step and occasional generator-quirk debugging; repo grows large (CI path filters and Turbo caching are the mitigation, not repo splitting); everyone sees all code — no per-team repo permissions (acceptable for a small team; revisit if org structure demands isolation).

## Links

- [system-architecture.md §2](../01-architecture/system-architecture.md) — canonical layout
- [frontend-architecture.md](../01-architecture/frontend-architecture.md), [backend-architecture.md](../01-architecture/backend-architecture.md)
- ADR-002 (Flutter packages), ADR-003 (modular monolith), ADR-010 (CI/test wiring)
- Phases: P0 (repo + tooling), P2 (generated `api_client`)
