# ADR-009: Modular game contract

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

The platform launches with two games and scales to ~10. If each game hand-rolls lifecycle, persistence, timers, RNG, and settlement, every game re-solves the hardest problems (money, recovery, fairness) with fresh bugs, and platform-wide guarantees (rules 2, 7, 10) become per-game promises.

## Decision

Every game implements one TS interface, **`GameDefinition`**, registered with the `game-engine` module ([game-architecture.md](../01-architecture/game-architecture.md)):

`meta` (code, version, player counts, timer + stake config) · `init` · `reduce(ctx, state, action)` — server-side reducer validating every action · `onTimeout` · `playerView(state, playerId)` — information hiding enforced here · `isTerminal` · `settle(state) -> SettlementInstruction[]`.

**The engine owns everything dangerous:** lifecycle (`created → starting → in_progress → settling → settled | voided`), persistence (append-only `game_events` + `game_snapshots` in PG, hot state in Redis, crash recovery = snapshot + replay), audit-logged CSPRNG via `ctx.rng` (`RngService` port, certified-RNG swappable, ADR-016), timers, and settlement applied via the wallet domain service — **games never touch money** (rule 10 ⛔).

Two enforcement mechanisms make the contract real:
- **Conformance suite** (ADR-010): every `GameDefinition` passes engine-level tests — reducer purity/determinism, illegal-action rejection, `playerView` leak checks, terminal/settlement invariants (settlement sums == pot; zero-sum with rake).
- **Version pinning:** in-flight matches run to completion on the `GameDefinition` version they started with; new versions apply to new matches only.

## Alternatives considered

- **Per-game bespoke services.** Maximum freedom per game; but persistence, recovery, RNG audit, timers, and settlement idempotency get reimplemented (and re-broken) N times, and the P8→P9→~10-games plan stops compounding. Rejected.
- **Scripting-engine plugins (Lua-class embedded rules).** Attractive for sandboxing and hot-loading, but adds a language boundary, kills TypeScript type-safety across the contract, complicates testing/debugging, and our games are trusted first-party code in the same repo — sandboxing solves a problem we don't have. Rejected.

## Consequences

**Positive:** each new game is mostly rules (reducer + views + settlement math), not infrastructure; platform guarantees are engine-enforced once; the dev-only "coin-duel" reference game (P6) validates the contract before any real game; OQ-05's choice of first casino game becomes structurally irrelevant.

**Negative (accepted):** **contract evolution discipline is permanent** — changes must be additive and versioned (mirroring rule 23), because a breaking change fans out to every game and its conformance runs; some games will strain the reducer shape (poker's multi-street hand fits; a future real-time-physics game might not — that would need a contract revision via ADR, not a bypass); the engine is a high-blast-radius component, so it carries the heaviest test load; version pinning means operating multiple live versions of a game's logic during rollouts.

## Links

- [game-architecture.md](../01-architecture/game-architecture.md), [game-engine.md](../02-domains/game-engine.md), [game-sessions.md](../02-domains/game-sessions.md)
- [system-rules.md](../00-project/system-rules.md) rules 2, 10, 23; ADR-006, ADR-008 (settlement), ADR-010 (conformance), ADR-016 (RNG)
- Phases: P6 (engine + reference game), P8/P9 (first real implementations)
