# ADR-002: Flutter architecture & state management

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

The app is a thin, real-time client for a server-authoritative platform ([rule 21](../00-project/system-rules.md)): it renders server state and fires intents; no business logic may live client-side. It needs testable state management for streams of WS game events, three flavors, a late designer restyle (ADR-019), and screens disciplined enough that "thin shell" stays true across ~10 games.

## Decision

- **State management: Riverpod v2 with code generation + freezed** immutable models. Domain state lives in providers/notifiers; screens are thin `ConsumerWidget` shells that watch state and dispatch events.
- **Navigation: go_router** with **typed routes in one central route config** — flow-as-configuration, mirrored in [ui-flow-map.md](../08-design/ui-flow-map.md) for designer onboarding.
- **Repository layer** wraps the **generated** `api_client` package (REST client + WS event models from `packages/contracts`, ADR-001). Providers depend on repositories, never on raw HTTP/socket objects.
- Layering: `screen (render + fire) → Riverpod providers → repositories → generated client → server`. Client-side validation is UX only; the server re-validates everything.

## Alternatives considered

- **Bloc.** Mature and disciplined, but event/state boilerplate per feature is heavy across many small game screens, and its DI story still needs a companion (provider/get_it). Riverpod's provider graph gives compile-safe DI + state in one model with less ceremony. Rejected.
- **Provider (package).** Riverpod is its successor by the same author: compile-time safety, no BuildContext coupling, testable overrides. No reason to adopt the predecessor. Rejected.
- **GetX.** Global-singleton style, magic context-free navigation, weak boundaries — invites exactly the logic-in-client sprawl rule 21 forbids; community reputation for unmaintainability at scale. Rejected.
- **Hand-rolled Navigator 2.0.** Full control, but Navigator 2.0's raw API is notoriously verbose; we would maintain our own router framework. go_router is the maintained, Flutter-team-backed layer over it and gives us declarative central config for free. Rejected.

## Consequences

**Positive:** compile-safe DI and state; freezed unions model game/connection states exactly; provider overrides make widget tests cheap; central typed routes keep flows reviewable and designer-legible; repository seam lets us fake the backend in tests and the kitchen-sink harness.

**Negative (accepted):** build_runner codegen (riverpod_generator + freezed + router) slows the edit loop and occasionally needs cache-clearing; Riverpod v2 has a learning curve (ref lifecycles, autoDispose pitfalls); go_router's redirect logic must be kept in the one config or auth-gating fragments; discipline that screens stay thin is enforced by review/lint, not the framework.

## Links

- [frontend-architecture.md](../01-architecture/frontend-architecture.md) — full layering
- [system-rules.md](../00-project/system-rules.md) rules 21, 25–27; ADR-001 (generated client), ADR-019 (placeholder-first UI)
- Phases: P2 (scaffold), P19 (restyle)
