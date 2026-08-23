# Frontend Architecture (Flutter)

Architecture of `apps/mobile` and its local packages. Companion docs: `docs/01-architecture/realtime-architecture.md` (WS client behavior), `docs/01-architecture/system-architecture.md` (system map), `docs/08-design/ui-flow-map.md` (screen flows). Built in P2; every later Flutter phase extends this skeleton. Governing rules: `docs/00-project/system-rules.md` rules 1, 21, 25–27.

## 1. Layer model

```
┌──────────────────────────────────────────────────────────┐
│ Screens (thin shells)                                    │  render state, fire events
│   compose ui_kit widgets only; zero business logic       │
├──────────────────────────────────────────────────────────┤
│ State layer — Riverpod v2 (code-gen) + freezed models    │  view state, orchestration
│   controllers/notifiers per feature; AsyncValue states   │
├──────────────────────────────────────────────────────────┤
│ Repository layer                                         │  domain-shaped API surface
│   wraps generated api_client + realtime client;          │
│   maps transport errors → domain errors                  │
├──────────────────────────────────────────────────────────┤
│ Transport                                                │
│   api_client (generated REST from packages/contracts)    │
│   realtime client (Socket.IO: ticket, seq, resume)       │
└──────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downward. Screens never import the transport layer; repositories never import Flutter widgets.

- **Screens** render a state object and dispatch events to a controller. No conditionals encoding game/money rules (rule 21) — client-side validation exists only as UX and is always re-validated server-side.
- **State layer**: one Riverpod controller per feature (e.g. `LoginController`, `WalletController`, `PokerTableController`). All models are `freezed` immutable data classes; async work surfaces as `AsyncValue<T>` so loading/error/data rendering is uniform. Code-gen (`riverpod_generator`) for providers — no hand-written provider boilerplate.
- **Repositories**: the only layer that knows HTTP/WS exist. They expose domain verbs (`walletRepository.history()`, `matchRepository.sendAction(...)`), attach idempotency keys to mutating REST calls, and translate transport failures into the typed error model (§7).
- **Transport**: `api_client` is generated from `packages/contracts` (OpenAPI + WS event schemas, via the melos codegen script) — hand-written DTOs are forbidden. The realtime client wraps Socket.IO with the auth/seq/resume protocol from `realtime-architecture.md §7–8`; the state layer consumes it as typed event streams.

## 2. Local packages & dependency rules

| Package | Contents | May depend on |
|---|---|---|
| `apps/mobile/packages/ui_kit` | design tokens (color/typography/spacing/radius/motion), theme, all shared widgets (`Button`, `Card`, `Dialog`, `Input`, `TableSeat`, `ChipStack`, `TimerRing`, `Toast`, `EmptyState`, …), intent-named animation wrappers (`CardDealAnimation`, `WinCelebration`, `ChipMoveAnimation`) | Flutter SDK, `assets` |
| `apps/mobile/packages/assets` | generated asset registry (final naming conventions, placeholder files) | nothing |
| `apps/mobile/packages/api_client` | generated REST client + WS event models from `packages/contracts` | Dart HTTP/socket libs; **no Flutter** |
| `apps/mobile` (app) | screens, state layer, repositories, router, flavor bootstrap | all of the above |

Enforced rules (lint + review checklist, per rule 25–26):

- Screens may **not** import `package:flutter/material.dart` colors/text styles directly — only `ui_kit` tokens and components. `Colors.red` in a screen is a build-review failure.
- Only `ui_kit` maps tokens → Material theme internals.
- Assets are referenced only through the generated registry — no string asset paths at call sites.
- Animations only via the intent-named wrappers, so a Rive/Lottie swap in P19 touches wrapper internals, never call sites (rule 26).
- `api_client` is regenerated, never edited; drift between contract and client is a codegen bug, fixed in `packages/contracts` or `/tools`.

## 3. Flavor system

Three flavors ↔ three backend environments (ADR-012, `docs/07-operations/environments-and-flavors.md`):

| | dev | staging | prod |
|---|---|---|---|
| applicationId | `<base>.dev` | `<base>.stg` | `<base>` |
| Name/icon | distinct ("DEV" badge) | distinct ("STG" badge) | final |
| Endpoints | dev API/WS | staging (incl. WAF + its own pins) | prod |
| Signing key | dev key | staging key | prod key (offline/HSM custody — critical infrastructure) |
| Firebase-or-similar project (if used, per OQ-09/OQ-12) | separate | separate | separate |

All three install side-by-side on one device (P2 acceptance criterion). Flavor selection is a build-time concern (Android product flavors + `--dart-define-from-file`), never a runtime toggle — a prod binary cannot be pointed at dev.

## 4. Config injection

`--dart-define-from-file` with one env file per flavor (`env/dev.json`, `env/staging.json`, `env/prod.json`) — **gitignored**; only `env/*.example.json` templates are committed (rule 14). Config carries endpoints, SPKI pin sets, flavor name, feature toggles safe for the client. **No secrets ever**: anything in the APK is public by definition; the config file contains only values we are content to publish. A CI string-dump spot check verifies no secret-shaped values in release binaries (P2 security scope).

Config is parsed once at bootstrap into a typed, immutable `AppConfig` exposed via a Riverpod provider; nothing reads `String.fromEnvironment` outside the bootstrap.

## 5. Navigation — go_router, flow as configuration

Single central typed route configuration (typed routes via `go_router_builder`). Route guards (auth required, account state, forced-update block, maintenance) live in the router config, not in screens. Because the entire flow graph is one declarative file, `docs/08-design/ui-flow-map.md` stays mechanically in sync with it, and P19 flow adjustments are router-config edits — not screen surgery.

The forced-update guard is non-negotiable (rule 17): a 426-style response from the API routes to a hard-block update screen that only offers the update path; no route escapes it.

## 6. State ownership — server truth vs client state

| State | Owner | Client handling |
|---|---|---|
| Balances, ledger history | server (PG ledger) | fetched views; never computed client-side beyond display formatting of server integers (minor units, rule 4) |
| Game state, hidden info, timers, turn order | server (`playerView` only) | rendered as received; client timers are cosmetic countdowns synced to server events |
| Session/auth tokens | server-issued | stored per `docs/04-security/authentication-security.md`; Keystore-backed device key |
| Form input, scroll position, animation state, selected tab | client (ephemeral) | Riverpod local state; disposable |
| Optimistic UI | client, provisional | allowed only for non-financial, non-game UX (e.g. marking a notification read); reconciled against server response, rolled back on rejection. Never for money or game actions. |

Rule of thumb: if losing the state on app kill would matter, the server owns it.

## 7. Error handling & presentation

`packages/contracts` defines the canonical error-code enum; the API returns a JSON error envelope (`docs/03-api/api-conventions.md`). The repository layer maps every failure into a sealed `AppError` hierarchy:

`network` (offline/timeout) · `authExpired` (silent refresh, then re-login flow) · `forcedUpdate` (hard-block route) · `maintenance` (maintenance screen) · `validation` (field-level messages) · `domain(code)` (mapped user-facing copy per code) · `rateLimited` (retry-after honored) · `unknown` (generic message + error-tracker report, per OQ-10).

Presentation is centralized: one mapper from `AppError` → ui_kit presentation (inline field error / `Toast` / `Dialog` / full-screen state). Screens never branch on raw status codes or error strings. No raw server messages shown to users; no PII in error reports (rule 15).

## 8. Offline & reconnect UX

Primitives built in P2, consumed everywhere:

- **Connectivity detection**: platform connectivity events + an active reachability probe against the API (connectivity ≠ reachability behind captive portals). Exposed as one `connectivityProvider`.
- **Offline banner**: global ui_kit banner, driven by that provider; screens don't implement their own.
- **REST retry**: mutating calls always carry an `Idempotency-Key`, so the retry queue can safely re-submit idempotent mutations after reconnect (bounded retries, exponential backoff + jitter). Non-idempotent operations don't exist by API convention.
- **WS resume UX**: on socket loss during play, the game screen shows a reconnecting overlay while the realtime client re-auths and issues `resume(matchId, lastSeq)` (`realtime-architecture.md §8`). Successful replay is seamless; fallback full `playerView` resync re-renders the table. The overlay makes clear the server clock keeps running — disconnection never pauses a live match (disconnect policy is game-defined).

## 9. Background/foreground lifecycle (live games)

Android will kill or suspend the app; the server does not care (server-authoritative timers, rule 2).

- **Backgrounded during a match**: socket may drop; on resume within the replay window, `resume(matchId, lastSeq)` restores silently. Beyond the window, full `playerView` resync. The game's disconnect policy (poker: grace → sit-out/auto-fold) has already applied server-side; the UI renders whatever state comes back — it never assumes the match waited.
- **Process death**: active-match id is persisted locally on match start; cold start checks it, and the router deep-links back to the game screen, which performs a full resync.
- Lifecycle transitions are observed centrally (one `AppLifecycleListener`-driven provider) — screens subscribe, they don't each register observers.
- Heartbeats stop when the OS suspends the isolate; the server's connection-health policy, not the client, decides when that becomes a disconnect.

## 10. Release build hardening

Release builds always compile with `--obfuscate --split-debug-info=<out>` — wired into the CI release lanes in P2 so it is never "added later"; symbol files are archived per build for crash symbolication (and never shipped). Honest framing (rule 3): obfuscation raises attacker cost; it prevents nothing. Root/emulator/hook detection and signature self-check are risk signals (`docs/04-security/mobile-app-hardening.md`, P10), not gates, and live outside this doc's scope.

## 11. Testing hooks

- **Kitchen-sink / dev harness screen**: dev-flavor-only route rendering every `ui_kit` component from tokens (P2 acceptance). It is the golden-test surface for `ui_kit` and the designer's live catalog for P19.
- **Dev tools panel** (dev flavor only): environment display, connectivity/WS status, feature-flag view, simulated-latency toggle. Compiled out of staging/prod via flavor config.
- Widget tests target screens with mocked controllers; controller tests mock repositories; repository tests mock transport. `integration_test` drives flavored e2e on device (ADR-010).
- Stable widget keys on interactive elements are part of the component contract in `ui_kit`, so integration tests survive restyles.

## 12. Decision rationale — Riverpod (ADR-002)

**Problem.** One state solution for a large, long-lived app: real-time streams (WS events), heavy async, code-gen'd immutability, testability without widget-tree gymnastics.

**Chosen.** Riverpod v2 with code generation + freezed models; go_router for navigation.

**Alternatives.**
- *Bloc*: strong discipline and traceability, but heavy ceremony per feature (event/state/bloc triples); stream-in/stream-out is redundant when repositories already expose typed streams. Discipline Bloc enforces structurally we enforce by the layer rules above at lower cost.
- *Provider*: Riverpod's predecessor; runtime lookup errors, weaker composition, no compile-safe provider graph. Superseded by its own author.
- *GetX*: convenience at the price of global mutable service-locator patterns, weak compile-time safety, and an all-in-one framework pulling in routing/DI/state opinions we'd fight. Unacceptable for a money-handling app where auditability of state flow matters.

**Why Riverpod.** Compile-time-safe dependency graph outside the widget tree (controllers testable without pumping widgets); first-class `AsyncValue` and stream support matching a WS-driven app; code-gen removes boilerplate while freezed guarantees immutable state; scoped overrides make flavor/test injection trivial.

**Trade-offs.** Code-gen build step (already required for freezed/api_client anyway); provider-graph discipline required — mitigated by the one-controller-per-feature convention and review checklist. Full rationale: ADR-002.
