# Domain: Casino Game #1

NestJS module `games/casino-game-1` — the first shipped `GameDefinition` plugin, built in **P8**. **Which game is undecided (OQ-05)**; the contract makes it structurally irrelevant (that is the point of ADR-009). This doc is therefore game-agnostic, with a **worked example shaped like Crash — the OQ-05 recommended candidate** — clearly labeled as such. If a different candidate is chosen, §9 bounds the blast radius.

Related: `docs/02-domains/game-engine.md` (contract, RNG, settlement), `docs/02-domains/matchmaking.md` (queue model / open-round join), `docs/02-domains/wallet.md` (house accounts, escrow), `docs/00-project/open-questions.md` (OQ-05).

## 1. Requirements any OQ-05 candidate must meet

1. **Multiplayer/social real-time** — players visibly play the same round against/alongside strangers (product core: "play vs strangers").
2. **Fast rounds** — seconds to ~1 minute; high round throughput exercises timers, settlement bursts, and reconnects (feeds P14 targets).
3. **Settlement through escrow** — house-banked or pooled, but always via the engine→wallet path, idempotent by matchId (rule 10). No candidate may need a bespoke money path.
4. **Provably-fair-compatible** — outcome derivable from an audited RNG draw; commit-reveal applicable (engine §8 helper) even if not surfaced in v1 UX.
5. **Thin client** — client renders `playerView` and fires bets/cash-outs; zero outcome logic client-side (rules 1–2, 21).

All four OQ-05 candidates (Crash, Hi-Lo duel, wheel, Andar Bahar/Teen Patti) satisfy these; regional-market and skill-positioning caveats live in the OQ-05 table.

## 2. Round lifecycle template (`GameDefinition` mapping)

A "round" is one engine match; consecutive rounds are consecutive matches in a persistent round-room (players join/leave between rounds; matchmaking's queue model degenerates to "join the open betting window" for round-based games — the formation transaction escrows each accepted bet).

```
open (betting window, T_open) → locked (no more bets) → resolving (RNG draw + outcome)
   → settling → settled → [next round: new match]
```

| Contract hook | Role |
|---|---|
| `init` | round config, empty bet book, opens betting window timer; pre-commit hash if provably fair (§5) |
| `reduce` | `placeBet` (validated: window open, min/max, per-user exposure cap, funds escrowed by the join transaction), `cancelBet` (window-open only → escrow refund instruction at settle… v1: cancel simply voids the bet and refunds at settlement), game-specific live actions (Crash: `cashOut`) |
| `onTimeout` | window close (`open→locked`), resolution tick(s) |
| `playerView` | public round state + caller's own bets; other players' bets/cash-outs are public by design in social games (no hidden info except unrevealed server seed) |
| `isTerminal` | outcome fixed and all live actions closed |
| `settle` | per-bet instructions: escrow → winners, escrow → `house_main` (lost stakes), house exposure per §3; idempotent by round matchId; escrow zeroes out |

Timers are server-side (P5 framework); resolution uses `ctx.rng` with audit-logged draws (engine §8) — never wall-clock-derived randomness.

## 3. House-banked settlement mechanics

- Player bets: user wallet → `match_escrow` (round-scoped) at bet placement, inside one PG transaction (same no-stuck-escrow guarantee as matchmaking: money moves only on accepted bet).
- Wins are paid from escrow first (losers' stakes) and the remainder from **`house_main`**; net house loss on a round = one ledger transaction leg `house_main → escrow` folded into settlement. Net house win: `escrow → house_main`.
- **Exposure control (config, enforced in `reduce` at bet time):** per-user max bet, per-round max total stake, and **max house exposure** = worst-case payout minus escrowed stakes; a bet that would exceed it is rejected (`max_exposure_reached`). `house_main` running balance monitored; below floor → per-game kill-switch drains (engine §10).
- Reconciliation: round escrow zeroes at settlement (canonical invariant); house PnL per round recorded in match outcome (game-sessions) for finance/risk dashboards.
- Pooled (player-vs-player) candidates use the same template minus `house_main` legs — winners are paid solely from escrowed stakes.

## 4. Disconnect policy

**Bets stand; resolution is server-side.** A disconnected player's bet resolves exactly as a connected one's; auto-behaviors are game-config (Crash: optional pre-set auto-cash-out multiplier honored server-side; without it, a Crash bet rides to the crash and loses — stated in game rules UI). Reconnect = standard resume (replay window or `playerView` resync). No refunds for disconnection (abuse vector otherwise); voids only via the engine's unrecoverable-round path (void+refund all bets, audited).

## 5. Worked example — Crash-shaped (OQ-05 **recommended candidate**, not decided)

- **Round:** betting window (~7s) → multiplier curve rises from 1.00× → server-drawn crash point ends it. Players `cashOut` any time before crash to lock stake × current multiplier; crash before cash-out = stake lost to house. House-banked; exposure cap limits simultaneous ride-alongs.
- **Provably-fair commit-reveal (engine §8 helper):**
  1. Before betting opens, server derives crash point from a server seed (optionally chained: seed_n = H(seed_{n+1}) so the whole series is pre-committed) and publishes `H(server_seed)` in the round-open event (client + `rng_draws` audit row).
  2. Round resolves; server reveals `server_seed` in the settlement event.
  3. Anyone recomputes: hash matches the pre-commitment, and `crashPoint = f(server_seed)` with `f` published in the game rules doc (includes the house-edge factor explicitly — honest-language rule: the edge is disclosed, not hidden in `f`).
  4. v1 UX: verification data exposed via API + history screen detail; a polished verifier UI is P19+.
- **`cashOut` ordering:** server timestamps/sequences cash-outs against the authoritative curve (client-displayed multiplier is cosmetic); a cash-out action arriving after the crash event is a losing ride, full stop — latency is a disclosed property of the game, and the curve timing is identical for all players in the round (no per-player advantage; this is the standard Crash model).
- **Curve/payout config:** crash-point distribution = payout curve config (house edge %, instant-crash probability, max multiplier cap); multiplier-vs-time function fixed in game rules.

## 6. Config schema (validated by engine against `meta.stakeConfigSchema`)

`{ roundTiming: {openMs, interRoundMs, maxRoundMs}, bet: {min, max, perUserMax, currency}, exposure: {maxRoundStake, maxHouseExposure, houseFloor}, payout: {curve|table params, houseEdge}, provablyFair: {enabled, chainLength}, disconnect: {autoCashOutAllowed} }` — per environment; `TST` values in dev/staging; real-currency values are a P18 concern.

## 7. UI components (from `ui_kit` — rule 25)

Reused: Button, Card, Dialog, Toast, EmptyState, TimerRing (betting window), ChipStack (bet display). Added to `ui_kit` in P8 (game-specific but token-styled, placeholder look): multiplier/round-curve widget, bet panel (amount stepper + quick amounts), round-history strip (last N outcomes), live bet-board (other players' bets/cash-outs), win/lose banner via `WinCelebration` animation wrapper. Screens stay thin render-state/fire-events shells; all round logic server-side.

## 8. Fairness & audit notes

Every draw audit-logged (`rng_draws`) whether or not commit-reveal is enabled; round history + reveal data retained with match records for dispute lookup (game-sessions §8). RNG certification (ADR-016, blocked on OQ-01) applies to this game's draw path before real money (P18). Kill-switch: per-game drain finishes the in-flight round, refuses the next (engine §10).

## 9. If OQ-05 lands elsewhere

The decision changes **only**: the game module (`games/casino-game-1` reducer/config/rules doc) and the game-specific `ui_kit` components + screen (§7). Unchanged: engine, matchmaking (round-join is the same degenerate queue), escrow/settlement mechanics (§3 covers house-banked and pooled), provably-fair plumbing (optional per game), disconnect template, config-schema mechanism, all of P6/P7. This isolation is the acceptance criterion for the abstraction — if a candidate switch would touch anything else, that is a design bug to fix in P8 planning, not absorb.

## 10. Metrics

Rounds/hour, players per round, bet volume, house PnL per round + cumulative (drift vs configured edge alerts — a wrong payout implementation shows up here first), exposure-cap rejections, cash-out latency distribution (Crash), void rate, reveal-verification failures (must be zero — any failure is an incident).

## 11. Phase mapping

**P8** module + config + UI + kill-switch wiring + game rules/fairness doc, on `TST` (acceptance: N concurrent players complete rounds with correct idempotent settlement; kill-switch drains gracefully); **P10** bet-velocity + pattern signals to risk; **P14** settlement-burst and reconnect-storm load; **P18** RNG certification + real-currency config; **P19** visual polish of the game screen (restyle only).
