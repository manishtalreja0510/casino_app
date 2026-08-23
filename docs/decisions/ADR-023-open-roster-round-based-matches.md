# ADR-023 — Open-roster, round-based matches

**Status:** ACCEPTED (2026-08-23) · **Phase:** P8 · **Supersedes:** nothing · **Related:** ADR-009 (game contract), ADR-024 (house-banked settlement), `docs/02-domains/casino-game.md`

## Context

Through P7 the engine had exactly one way to admit players: matchmaking assembles a fixed
roster from a queue, and `createMatch` seats everyone and charges everyone **in one
transaction, or nobody**. That guarantee is the whole point of P7 — in a two-player duel,
one player who cannot pay means there is no game, and charging the other for a match that
never started is the worst failure the system can produce.

Crash (P8, OQ-05) does not work that way, and neither will most casino games. A round opens
empty, players bet into it during a window, and it starts with whoever paid. Applying the
all-or-nothing rule here would be actively wrong: one player's declined bet would cancel
everyone else's, turning an ordinary event (someone is short of funds) into an outage for
the whole table.

`docs/02-domains/casino-game.md §2` anticipated this as "matchmaking's queue model
degenerates to 'join the open betting window'". This ADR makes it concrete, and records
that it is a **second admission model**, not a replacement.

Three smaller problems had to be solved with it:

1. A round game's outcome depends on **elapsed time**. `GameContext.now()` was documented
   as replayable but implemented as `Date.now()`, which nothing had noticed because the
   reference game never asks the time. Replaying a Crash round would have priced every
   cash-out at whatever time the replay ran.
2. A round game has a deadline **nobody's move created** — at lift-off, and again after a
   restart. Timers live in the process that armed them, so a resumed round would have sat
   in flight forever with stakes in escrow.
3. A round is a **shared spectacle**. Per-player views alone cannot serve a room of
   spectators, and broadcasting raw state would leak the unrevealed seed.

## Decision

**1. A second admission model, declared by the game.**
`GameMeta.mode` is `'matchmade'` (default, unchanged) or `'rounds'`. Round games get:

- `createOpenMatch` — a match with no players. Refused for matchmade games, because an
  empty matchmade match is a bug that would silently produce a game with no players.
- `joinMatch` — one player, one seat, one buy-in, in **its own** transaction. The match row
  is locked for the join, so seats and capacity cannot race, and an optional `guard`
  callback lets the caller apply round-level limits *inside* that lock (exposure caps are
  otherwise a read-then-write race two simultaneous bets both win).
- `startMatch` — starts with whoever joined, or reports `started: false` so the caller can
  void an empty round. An empty betting window is an ordinary outcome, not an error.

`createMatch` is untouched. Matchmade games keep all-or-nothing formation exactly as P7
proved it.

**2. The clock is recorded like an RNG draw.** `ClockService` records `now()` reads with
the event that consumed them (`__clock`, beside `__draws`) and replays them in order.
Running past the recorded reads is a hard error, not a fresh reading: a silent fallback
would make replay *look* successful while producing a different match.

**3. `GameDefinition.pendingTimer(ctx, state)`** — optional; the deadline the current state
calls for *right now*. The engine arms it after `init` and after recovery replays a match
back into memory. `ReduceResult.timer` still covers deadlines a move creates.

**4. `GameDefinition.publicView(ctx, state)`** — optional; what a spectator may see. Rooms
of the shape `round:{tierId}` are public to authenticated players and carry only this. A
game that defines no public view broadcasts nothing, which is the safe default.

**5. `GamePlayer.meta`** — per-player data fixed at join time (Crash's auto-cash-out
target; poker's sit-out state in P9). It belongs to the roster rather than to state because
it is decided before `init` runs, and it is replayed with the roster.

**6. Scheduled work is a role, not a capability.** Rounds — and the matchmaking formation
sweep alongside them — are the only things the platform does without anyone asking, so a
`SCHEDULED_WORK_ENABLED` instance role plus a short Redis lease per tier decides who drives
them. The lease is **not** what keeps money correct —
every movement is still a PostgreSQL transaction with its own locks and idempotency key —
so the worst a lost or double-granted lease can do is open an unwanted round or delay the
next one (rule 7).

## Alternatives considered

- **Force Crash through `createMatch`.** Would require knowing the roster before betting
  opens, which is the opposite of how the game works, or charging everyone atomically at
  window close — reintroducing the "one bad bet cancels the round" failure.
- **A separate round engine.** Would duplicate the event log, recovery, RNG audit and
  settlement, and split the money path in two. The engine's guarantees are the reason it
  exists; a second one would be a second set of bugs.
- **Push periodic multiplier ticks from the server** instead of `publicView` plus client
  animation. Rejected on cost: ten events per second per room, for a number that is
  cosmetic. The curve's *parameters* are sent instead so the client draws the server's
  curve rather than carrying its own copy of the rules — and no payout is ever computed
  from what it draws.
- **Leave `now()` as `Date.now()` and forbid clock-dependent games.** That is a rule the
  first real game would have broken. Recording the clock costs a few integers per event.

## Consequences

**Good.** Two admission models, both explicit and both testable; the engine still knows
nothing game-specific (it routes on declarations, never on a game code); replay now
genuinely reproduces the match that was played, which is what dispute resolution rests on;
P9's poker table gets `joinMatch`, `guard` and `meta` for sit-down/buy-in without further
engine work.

**Costs.** Two lifecycle paths to keep correct instead of one; a Redis lease to operate and
monitor; every event carrying its clock reads (a few dozen bytes); `pendingTimer` and
`publicView` are optional hooks, so a game that needs them and forgets them fails in a way
the conformance suite does not yet catch (§ debt, PHASE-08 §24).

**Not changed.** All-or-nothing formation for matchmade games. The ledger. Idempotency by
match id. Kill-switch semantics. The rule that games never touch wallets (rule 10).
