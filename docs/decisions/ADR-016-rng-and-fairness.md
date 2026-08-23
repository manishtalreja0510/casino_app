# ADR-016: RNG & Fairness

**Status:** PROPOSED (architecture decided; certification lab and certification scheme blocked on OQ-01 — the license dictates the requirement, GLI-19-class expected)
**Date:** 2026-08-23

## Context

Every game outcome depends on randomness; regulators certify it (typically GLI-19 or equivalent, exact scheme per OQ-01), players distrust it, and attackers probe it. Randomness must be server-side only (rules 1–2), auditable after the fact, and swappable for a certified module without touching game code.

## Decision

- **`RngService` port**, injected into games via `ctx.rng` (ADR-009). No game imports a randomness source directly; **no client-side randomness ever** influences an outcome.
- **Implementation now:** OS CSPRNG (`crypto.randomBytes`-class) behind the port, with rejection sampling for unbiased integer ranges.
- **Every draw is audit-logged:** match id, game code, draw purpose, values (or commitment where values are secret until reveal), timestamp — into the append-only audit/game-event stream, so any hand or round is reproducible in a dispute.
- **Deck shuffles:** Fisher–Yates over the CSPRNG, full-deck, server-side; hole-card secrecy enforced at `playerView` (ADR-009), never by client filtering.
- **Certified-RNG readiness:** the port is the seam — when OQ-01 fixes the scheme, a certified RNG module (GLI-19-class) replaces the implementation with zero game-code change; the audit-log format is designed to satisfy lab evidence requirements.
- **Commit–reveal provably-fair helper** offered by the engine for games where it fits (e.g. Crash, the OQ-05 recommendation): publish `hash(seed‖salt)` before the round, reveal after, so players can verify outcomes independently. Optional per game; poker's hidden-information model doesn't fit it and relies on certification + audit instead.

## Alternatives considered

- **PRNG seeded per match** (e.g. seeded Mersenne/xorshift for "replayability") — rejected: predictable-seed attacks are the classic casino exploit; replayability comes from the event log, not from re-derivable randomness.
- **Blockchain / VRF randomness** — rejected: latency and complexity for every draw, and no candidate regulator requires it; commit–reveal gives player-verifiable fairness where wanted at zero external dependency.
- **Buying a certified RNG library now** — premature: certification is scheme+lab-specific and lab choice hangs on OQ-01; spending pre-license risks certifying against the wrong scheme.

## Consequences

- Games are certification-agnostic; P18's RNG-certification work is confined behind one port plus lab paperwork.
- Draw audit logging adds write volume to hot paths; accepted — it is the dispute-resolution and lab-evidence backbone.
- Commit–reveal adds round choreography (commit publish, reveal, verification UI) only to games that opt in.
- Until certification, fairness claims in any user-facing text must stay modest (honest-language rule 3).

## Links

- ../00-project/open-questions.md (OQ-01, OQ-05), ../01-architecture/game-architecture.md, ../02-domains/game-engine.md
- ../00-project/system-rules.md (rules 1–3), ADR-009 (game contract), ADR-006 (server-authoritative)
- Phases: P6, P8, P18
