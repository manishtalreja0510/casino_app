# ADR-019: Placeholder-First UI & Design-Token Migration

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

No designer is on board; one will be, late (P19). Every screen built before then is at risk of being thrown away — unless the codebase structurally separates *what the UI is* from *how it looks*. The failure mode to avoid is a "design integration" phase that becomes a rewrite of every screen.

## Decision

From P2 onward, before any real screen exists:

- **Design tokens** (color/typography/spacing/radius/motion) are the only source of style values, in `apps/mobile/packages/ui_kit`. **No screen hardcodes a style value** — enforced by lint rule / review checklist (rule 25 ⛔).
- **`ui_kit` components** (Button, Card, Dialog, Input, TableSeat, ChipStack, TimerRing, Toast, EmptyState, …) are the only UI building blocks; **screens are thin** render-state/fire-events shells over the Riverpod layer.
- **Generated asset registry** (`packages/assets`): final naming conventions now, placeholder files; call sites reference registry entries, never paths.
- **Intent-named animation wrappers** (`CardDealAnimation`, `WinCelebration`, `ChipMoveAnimation`) with simple built-in implementations, internally swappable to Rive/Lottie without touching call sites (rule 26).
- **Router as configuration:** central typed go_router config; flow changes are config edits; `docs/08-design/ui-flow-map.md` is the designer-onboarding artifact, kept current.
- **Deliberately plain dark placeholder theme** — visibly unfinished on purpose, so nobody polishes it and nobody mistakes it for the product (rule 27).
- **P19 = restyle, not rewrite**, with a **diff-confinement acceptance criterion**: the design-integration diff is limited to token values, `ui_kit` component internals, asset files/registry, and router config. A P19 change that needs to edit a screen body signals a structure violation to fix, not a diff to wave through.

## Alternatives considered

- **Build polished UI now** — rejected: the designer will replace it wholesale; polish effort pre-designer is written off by definition, and polished placeholder invites attachment to throwaway visuals.
- **Design-first waterfall** (hire/wait for designer before building) — rejected: blocks all client development behind an unscheduled dependency; the token/kit seam makes waiting unnecessary.
- **Per-screen ad-hoc styling, cleanup later** — rejected: hardcoded values metastasize; "later cleanup" against N shipped screens is precisely the rewrite this ADR exists to prevent.

## Consequences

- P19 becomes parallelizable (runs alongside P10+) and low-risk; the diff-confinement check makes "restyle not rewrite" testable rather than aspirational.
- Cost now: building `ui_kit` components and lint enforcement before they're strictly needed, and living with an ugly app for a long time — intentional.
- Golden tests on `ui_kit` (ADR-010) pin component behavior so the restyle can't silently change semantics.
- Risk: token/component vocabulary chosen by engineers may not match the designer's system; mitigated by keeping tokens conventional (semantic roles, type scale) and the flow map current.

## Links

- ../01-architecture/frontend-architecture.md, ../08-design/ (ui-flow-map.md), ../00-project/system-rules.md (rules 25–27)
- ADR-002 (Flutter architecture), ADR-010 (testing — golden tests)
- Phases: P2, P19
