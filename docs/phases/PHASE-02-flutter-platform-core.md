# Phase 02 — Flutter platform core

## 1. Phase overview
The Flutter app chassis **and the whole UI strategy skeleton**: flavors and build-time config, a central typed router, the `ui_kit` package (design tokens + deliberately plain placeholder theme + components), the generated asset registry with final naming, intent-named animation wrappers, the Riverpod state layer, the generated API client, and reconnect/offline UX primitives. Roadmap entry: `../MASTER_ROADMAP.md` §P2.

**Why the whole skeleton now:** P19 (design integration) must be a restyle, not a rewrite (ADR-019). That is only true if every screen written from P3 onward composes `ui_kit` components and reads tokens. Building this after the first screens exist would mean rewriting them.

## 2. Current status
`COMPLETE` — 2026-08-23. Mirrored in `../progress.md`.

## 3. Objective
A Flutter app that builds for three flavors against three endpoints, containing no screen that hardcodes a style value, and a component gallery proving the token system — so that P3's first real screens have nothing to invent.

## 4. Dependencies
P0 (COMPLETE) for the workspace; P1 (COMPLETE) for the API the client will call. Flutter SDK 3.x / Dart 3.13 installed in this environment. ADR-002 (Riverpod + go_router), ADR-019 (placeholder-first UI), ADR-012 (flavors).

## 5. Preconditions
Flutter on PATH; `apps/mobile` currently a README-only slot (P0 §23 deferred it here deliberately).

## 6. Existing-code analysis
`apps/mobile/README.md` states what this phase builds and the rules that apply. `packages/contracts` holds the API constants, `Money`, error codes, and health types this client must mirror. `apps/api` serves `/api/v1/health` and returns the `{ error: { code, message, details?, traceId } }` envelope — the client's error mapping must match it exactly.

## 7. Scope
1. **App skeleton** — `apps/mobile` Flutter app, analysis options, folder structure per `../01-architecture/frontend-architecture.md`.
2. **Flavors** — `dev`/`staging`/`prod` with distinct applicationId suffixes, app names, and endpoints; config via `--dart-define-from-file` with gitignored per-flavor files and committed `.example` templates (rule 14).
3. **`ui_kit` package** — token system (colour, typography, spacing, radius, motion, elevation) as `ThemeExtension`s; plain dark placeholder theme; core components (button, card, input, dialog, toast, empty/loading/error states, offline banner, balance display, countdown ring).
4. **`assets` package** — generated registry, final naming conventions, placeholder files; missing asset = build error.
5. **Animation wrappers** — intent-named (`CardDealAnimation`, `WinCelebration`, `ChipMoveAnimation`) with built-in implementations swappable to Rive/Lottie without touching call sites.
6. **Router** — central typed `go_router` config; flow as configuration.
7. **State layer** — Riverpod scaffold, config/env providers, an API client provider, connectivity provider.
8. **`api_client` package** — typed client over the REST surface with the contract error envelope mapped to typed Dart failures, and money as integer minor units.
9. **Reconnect/offline UX primitives** — connectivity detection, offline banner, retry policy for idempotent requests.
10. **Kitchen-sink gallery screen** — every component in every state, the developer-facing proof of the token system and the designer's reference.
11. **Tests** — widget tests for components, golden tests for the theme, unit tests for client error mapping and config.

## 8. Out of scope
Real product screens (P3+ — only the gallery and a placeholder home exist). WebSocket client (P5). Auth flows (P3). Visual polish, real assets, Rive/Lottie (P19 — placeholders only). iOS (OQ-04). Custom lint plugin enforcing "no hardcoded styles" (see §24 — enforced by review + gallery convention until a lint rule is worth its maintenance).

## 9. Architecture considerations
Implements `../01-architecture/frontend-architecture.md`, `../08-design/design-system.md`, `../08-design/asset-animation-pipeline.md`, ADR-002 and ADR-019. Screens stay thin: render state, fire events, no business logic (rule 21). `ui_kit` must not depend on app code or on Riverpod — it is presentation-only, so the designer's restyle cannot break logic.

## 10. Database changes
None.

## 11. Backend changes
None. (The client consumes P1's health endpoint as its first real integration.)

## 12. Flutter changes
The entire phase. New packages: `apps/mobile/packages/ui_kit`, `.../assets`, `.../api_client`.

## 13. API changes
None. The Dart client is written against the existing contract; drift is caught by the client's tests, not by hand-comparison.

## 14. WebSocket changes
None (P5).

## 15. Security considerations (MANDATORY)
- **No secrets in the binary (rule 14).** Only endpoints and flags travel via `--dart-define`; dart-defines are *not* secret storage — anything in the APK is public. Config files are gitignored, `.example` templates committed. Verified by a string dump over the built artifact where a build is possible.
- **Release builds obfuscate** (`--obfuscate --split-debug-info`) — a cost-raiser, never a boundary (rule 1). Symbol files are retained for crash symbolication and are not committed.
- **The client trusts nothing it computes.** No balance math, no outcome, no entitlement decision. `Money` is integer minor units and formatting only (rule 4).
- **Error surface leaks nothing.** The client shows the contract `code`/`message` and the `traceId` for support; never raw response bodies.
- **Transport.** HTTPS enforced for non-dev flavors; cleartext permitted only for `dev` against localhost, and configured per flavor so it cannot leak into staging/prod. Certificate pinning is P3's concern (ADR-013) — deliberately not stubbed here.
- Checklist: `../04-security/security-checklist.md` §A and §D.

## 16. Edge cases
Missing dart-define file (build must fail loudly, not silently pick defaults); API unreachable (offline state, not a crash); slow/flapping connectivity; malformed error payloads; very small and very large text scale; dark/light system settings; long display names; zero/negative/huge balances; RTL layout.

## 17. Testing strategy
`flutter analyze` clean; widget tests per component including states; golden tests pinning the placeholder theme (so an accidental style change is caught, and so P19's restyle shows up as an intentional golden update); unit tests for API client error mapping, money formatting, and flavor config resolution. Where the Android SDK is available, a per-flavor build proves the flavor wiring; otherwise that is recorded honestly as unverified rather than assumed.

## 18. Implementation plan
Packages and tooling → tokens + theme → components → assets registry + animation wrappers → api_client → router + Riverpod scaffold → gallery + placeholder home → tests → verification.

## 19. Rollback / recovery
Additive; no migrations, no server change. Rollback = revert the commit.

## 20. Acceptance criteria
1. `flutter analyze` reports no issues; `flutter test` green.
2. No screen or component outside the token files references a raw colour, font size, radius, or spacing literal.
3. Three flavors resolve three distinct endpoints and app identities from their config files, and a missing config file fails the build.
4. The gallery renders every component and state from tokens alone.
5. The API client maps the backend error envelope to typed Dart failures, including a `traceId`, and money stays integer minor units end to end.
6. Golden tests pin the placeholder theme.
7. `pnpm verify:all` green (its Flutter lanes activate this phase).

## 21. Definition of done
Acceptance criteria met · tests green, no skips · analyze clean · security checklist §A/§D closed · `../08-design/ui-flow-map.md` updated with what now exists · docs + `progress.md` updated · completion report written.

## 22. Completion report

**Delivered as planned.** All 11 scope items: the Flutter app, three flavors with `--dart-define-from-file` config, `ui_kit` (4 token sets as `ThemeExtension`s, placeholder dark theme, 10 components), the `app_assets` registry with 18 placeholder files under final names, three intent-named animation wrappers, the central `go_router` config, the Riverpod state layer, the `api_client` package, offline/reconnect primitives, the component gallery, and 54 tests.

**Verification.** `flutter analyze` clean across app and all three packages; **54 Flutter/Dart tests green** (15 app, 21 ui_kit incl. 3 goldens, 13 api_client, 5 config/asset) plus the full backend suite — `pnpm verify:all` passes all 11 lanes.

**Three things worth calling out.**

1. **Rule 25 is now executable, not aspirational.** `test/no_hardcoded_styles_test.dart` scans `lib/` for raw `Color(0x…)`, `Colors.*`, `fontSize:`, numeric `BorderRadius.circular(…)` and numeric `EdgeInsets`, and fails with file:line. I verified it actually fails by injecting `Color(0xFF00FF00)` into the home screen — it caught it at `home_screen.dart:26` — then removed it. A rule this easy to erode needed a test, not a review convention.
2. **`BalanceDisplay` takes a formatted `String`, deliberately.** A component accepting a number invites exactly the client-side money arithmetic the project forbids (rules 1, 4). `ui_kit` therefore has no dependency on `api_client` and performs no money logic at all.
3. **Offline and server-unreachable are distinct states.** "You are offline" is a lie when the device has a network and the backend is down, so `AppConnectionState` separates them and the home banner says which is true.

**Deviations.**
- `ConnectionState` renamed `AppConnectionState` (collides with Flutter's own).
- `dart fix --apply` was run to satisfy `require_trailing_commas` in test files.
- The Flutter test lanes are per-package in `verify-all.sh`, since `flutter test` at the app root does not descend into local packages.

**Android flavors are configured but the build is UNVERIFIED — see §23.**

## 23. Known limitations

**The Android build cannot be verified in this environment, and I have not claimed otherwise.** The network policy blocks `dl.google.com` (403 at the proxy), so the Android SDK cannot be installed; Gradle would additionally need `maven.google.com`. Consequences:

- `android/app/build.gradle.kts` declares the three product flavors (`dev`/`staging`/`prod`, with `.dev`/`.stg` applicationId suffixes and per-flavor `app_name`), and the manifest uses `@string/app_name`. This configuration is **written correctly but never compiled**. The first developer with an Android SDK must run `flutter build apk --flavor dev --dart-define-from-file=config/dev.json` and confirm; treat the flavor wiring as unproven until then.
- Roadmap acceptance "three flavors install side by side" needs real devices and remains outstanding.
- What *is* verified is the part that decides behaviour: the Dart-side config resolution — flavor parsing, the refusal of unknown flavors, the https requirement outside dev, the failure when no config was supplied, and three distinct endpoints — all covered by tests.

Also outstanding: no custom lint *plugin* (the executable test covers the rule at lower cost); no WebSocket client (P5); no certificate pinning (P3, ADR-013 — deliberately not stubbed); obfuscation flags are documented in `config/README.md` but unexercised without a build; goldens were generated on this Linux toolchain and may need regenerating if CI later runs a different one.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Android build unverified (no SDK reachable) | Flavor/signing wiring unproven | First environment with an Android SDK, or a CI runner |
| `api_client` hand-written, not generated from OpenAPI | Contract drift is caught by tests, not by codegen | When the REST surface grows (P3/P4) |
| Golden images are toolchain-specific | May need regeneration on another platform | If/when the Flutter lane runs elsewhere |
| No integration test against a live API from the client | Client↔server contract proven only by unit tests | P3, when there is an auth flow worth driving end to end |
| `connectivity_plus` untested on a real device | Emulated in tests via provider overrides | First device run |

## 25. Next-phase dependencies
P3 inherits: router, tokens, components, API client with error mapping, config system, and the offline/reconnect primitives — its auth screens should need no new infrastructure. P5 extends the client with the WebSocket layer. P19 restyles `ui_kit` only. **Stop after this phase.**
