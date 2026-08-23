# apps/mobile — Flutter client (Android first)

**Status: workspace slot only. No Dart source yet — the Flutter app is built in P2.**

## Why this directory is empty

P0 established the monorepo rails. A Flutter SDK is **not available in the environment where P0 was executed**, so any Dart code written here could not be compiled, analysed, or tested. Shipping unverifiable code would violate rule 18 (never claim completion on unverified work), so the mobile scaffold is delivered in **P2 — Flutter platform core**, where a Flutter SDK is a stated precondition.

## What P2 builds here (already designed)

| Item | Design doc |
|---|---|
| App skeleton, Riverpod + freezed state layer, thin screens | `../../docs/01-architecture/frontend-architecture.md` |
| Flavors `dev`/`staging`/`prod`, `--dart-define-from-file` config | `../../docs/07-operations/environments-and-flavors.md`, ADR-012 |
| `packages/ui_kit` — design tokens, placeholder dark theme, components | `../../docs/08-design/design-system.md`, ADR-019 |
| `packages/assets` — generated asset registry, naming conventions | `../../docs/08-design/asset-animation-pipeline.md` |
| `packages/api_client` — generated from `packages/contracts` | `../../docs/01-architecture/frontend-architecture.md` |
| Central typed `go_router` config | `../../docs/08-design/ui-flow-map.md` |
| Mobile CI lane (analyze, test, build per flavor) | `../../docs/07-operations/ci-cd.md` |

## Standing rules that apply the moment code lands here

- No screen hardcodes a colour, font, size, radius, or spacing value — tokens and `ui_kit` only (rule 25).
- No secrets in the binary. `--dart-define-from-file` files are gitignored; only `.example` templates are committed (rule 14).
- No business logic duplicated from the backend; the client renders server state and fires events (rule 21).
- Release builds use `--obfuscate --split-debug-info`; debug symbols are retained for crash symbolication.
