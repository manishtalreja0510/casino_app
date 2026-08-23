# Domain: Game Engine

> **P8 additions (ADR-023).** The engine gained a second admission model and the two hooks
> a self-driven game needs. All are additive; matchmade games are unchanged.
>
> - `createOpenMatch` / `joinMatch` / `startMatch` — an open roster with **per-player**
>   atomic buy-in, alongside `createMatch`'s all-or-nothing formation. `joinMatch` takes an
>   optional `guard` the engine runs inside the lock, for limits that depend on who has
>   already joined.
> - **The clock is recorded like an RNG draw.** `GameContext.now()` was documented as
>   replayable and implemented as `Date.now()`; nothing noticed because the reference game
>   never asks the time. `ClockService` records reads with the event that consumed them and
>   replays them in order, so a time-dependent game replays as the match that was played.
> - `pendingTimer(ctx, state)` — the deadline the current state calls for, armed after
>   `init` and after recovery. Without it a resumed round sits in flight forever.
> - `publicView(ctx, state)` — the only state a shared room may carry.
> - `GameMeta.banking` routes settlement (ADR-024); `GameMeta.mode` routes admission;
>   `GamePlayer.meta` carries per-player data fixed at join time.
> - `onMatchChanged` — an in-process listener so a round owner can publish lifecycle events.
>   Presentation only; it never carries money, and anything durable reads PostgreSQL.

NestJS module `game-engine` — the contract runtime that hosts every game (ADR-006, ADR-009). Games are plugins implementing `GameDefinition`; the engine owns lifecycle, action processing, persistence, timers, RNG, recovery, and settlement. Built in **P6**, validated by the dev-only "coin-duel" reference game before any shipped game (P8/P9) exists.

Related: `docs/02-domains/game-sessions.md` (match records / DB truth), `docs/02-domains/matchmaking.md` (how matches form), `docs/02-domains/wallet.md` (escrow/settlement services), `docs/01-architecture/realtime-architecture.md` (transport). Undecided items: none engine-blocking; RNG certification lab is OQ-01-dependent (ADR-016 PROPOSED).

## 1. Purpose

- Run any registered `GameDefinition` server-authoritatively (rules 1–2): every action validated and reduced on the server; clients only render `playerView` and fire actions.
- Guarantee the financial and fairness invariants **once**, at the engine level, so no per-game code can violate them (rule 10: games never touch wallet/ledger).
- Make game state recoverable and disputable: append-only event log in PG is the truth; Redis is a latency cache.

## 2. Owned data

| Table (PG) | Contents | Notes |
|---|---|---|
| `game_definitions` | code, version (semver), status (active/draining/disabled), config schema hash, registered_at | registry of deployed game modules; one row per (code, version) |
| `game_events` | id (UUIDv7), match_id, seq (per-match, gapless, unique `(match_id, seq)`), type, actor (user id \| `engine` \| `timer`), payload JSONB, created_at | append-only; UPDATE/DELETE revoked + trigger guard, like the ledger |
| `game_snapshots` | match_id, seq (event seq the snapshot reflects), state JSONB, created_at | periodic (every N events / T seconds, per-game config); latest wins, older pruned by retention job |
| `rng_draws` | id, match_id, seq (event seq that consumed it), purpose, draw bytes/values, algorithm, commit hash (nullable), created_at | audit log of every RNG draw (ADR-016) |
| `engine_timers` | timer_id, match_id, fires_at, payload, fired_at nullable | PG mirror of scheduled timers for recovery; live scheduling via P5 timer framework (BullMQ delayed jobs) |

Redis (never truth): hot `GameState` per match (`engine:state:{matchId}`), per-match event ring buffer for WS resume (~2 min window), per-match engine lock. Match lifecycle rows (`matches`) are owned by `game-sessions` (see that doc) and driven by engine callbacks.

## 3. Registration & discovery

Game modules (`games/*`) register at boot: `engineRegistry.register(definition: GameDefinition)`. The engine validates `meta` (code, name, semver version, minPlayers/maxPlayers, turn-timer config, stake-config JSON Schema), verifies the config schema compiles, and upserts `game_definitions`. Duplicate (code, version) with a different schema hash fails startup — a changed game must bump its version. Discovery API (consumed by matchmaking and lobby): list active definitions + stake config; a definition in `draining`/`disabled` is excluded from new-match formation but keeps serving in-flight matches (see §9, §10).

## 4. Contract hosted (canonical shape — restated, not redefined)

```ts
interface GameDefinition {
  meta: { code; name; version; minPlayers; maxPlayers; turnTimerConfig; stakeConfigSchema };
  init(ctx, players, config): GameState;
  reduce(ctx, state, action): { state; events[] };        // validates EVERY action
  onTimeout(ctx, state, timerId): { state; events[] };    // server-authoritative timers
  playerView(state, playerId): PlayerView;                // information hiding enforced HERE
  isTerminal(state): boolean;
  settle(state): SettlementInstruction[];                 // engine applies via wallet
}
```

`ctx` provides: `ctx.rng` (RngService draw API, §8), clock, logger (pino child, matchId-tagged), match metadata (matchId, players, stakes, config). Reducers are pure-ish: no I/O, no wall-clock reads outside `ctx.clock`, no randomness outside `ctx.rng` — enforced by the conformance suite (§13) because replay determinism depends on it.

## 5. Match lifecycle (engine-owned)

`created → starting → in_progress → settling → settled | voided`

| State | Entered when | Engine responsibilities |
|---|---|---|
| `created` | matchmaking hands over a formed match (PG match row exists, escrow funded) | allocate match room, pin game version (§11) |
| `starting` | all participants confirmed / connected or start-timeout fires | run `init`, persist `match_started` event + initial snapshot, broadcast initial playerViews |
| `in_progress` | init committed | action pipeline (§6), timers |
| `settling` | `isTerminal(state)` true after a reduce/timeout | call `settle`, execute escrow settlement (§7), block further actions |
| `settled` | wallet settlement transaction committed | final playerViews broadcast, hot state expired, snapshot finalized |
| `voided` | unrecoverable failure or admin/kill action | refund path (§9) |

Transitions are recorded both as `game_events` and on the `matches` row (game-sessions is DB truth for lifecycle timestamps; engine emits domain events it consumes).

## 6. Action pipeline

Per incoming action (from `/game` WS via the realtime module, or from a timer):

1. **Authz** — session valid, sender is a participant of `matchId`, account not frozen/self-excluded, per-game kill-switch not `disabled`.
2. **Schema validation** — action payload against the game's versioned action schema from `packages/contracts`; malformed → rejected with error envelope, counted as a risk signal on repeat.
3. **Engine lock per match** — Redis lock `engine:lock:{matchId}` (Redlock-style single instance) + fencing token check against the last persisted `seq` in PG, so a stale lock holder cannot commit (correctness lives in PG per system rule; the Redis lock is throughput, the `(match_id, seq)` unique constraint is the actual guard).
4. **Reduce** — `reduce(ctx, state, action)`; a rejecting reducer returns an error event, state unchanged; invalid actions never advance `seq`less state silently.
5. **Persist event** — append to `game_events` with next `seq` in a single PG transaction (plus snapshot if due, plus rng_draw rows consumed by this reduce). **Commit is the point of truth.**
6. **Broadcast** — only after commit: recompute `playerView(state, p)` per participant, emit to `match:{matchId}` room per-player (filtered), push into the Redis resume ring buffer, update Redis hot state, (re)schedule timers the reduce requested.

Ordering invariant: steps 5→6 never invert. A crash between 5 and 6 is safe — recovery rebroadcasts from the log.

## 7. Settlement orchestration

On `settling`, the engine translates `SettlementInstruction[]` into **one idempotent wallet call**: `walletEscrowService.settleMatch(matchId, instructions)` — idempotency key derived from matchId (rule 10, wallet canonical flow). Wallet performs, in a single ledger transaction: `match_escrow` → winner wallet accounts (+ rake → house rake account where configured). Invariants the engine asserts before calling: instructions sum exactly to the escrow balance for the match (escrow zeroes out — the wallet enforces this too and rejects otherwise); every payee is a participant or a house account. Retry on failure is safe (idempotent); persistent failure → match stays `settling`, alert fires, manual runbook — never partial payout. Poker refines this: its escrow is table-scoped and per-hand `settle` moves rake only, with the escrow-zero invariant applied at table close (`poker.md §5`).

## 8. RngService port (ADR-016)

- Default implementation: Node CSPRNG (`crypto.randomBytes`/`randomInt` derivatives), rejection-sampled for unbiased ranges.
- **Every draw is audit-logged** to `rng_draws` (purpose, values, consuming event seq) in the same transaction as the event that consumed it — a draw with no event, or an event with an unlogged draw, is a reconciliation finding.
- Port interface so a **certified RNG** (GLI-19-style, lab choice blocked on OQ-01) is a swap, not a rewrite; certification is a P18 gate for shipped games.
- **Commit-reveal helper** for provably-fair games: `rng.commit(seed) → hash` published pre-round, `rng.reveal()` post-round; used by the casino game (see `casino-game.md §5`), optional per game.
- Reducers never call platform randomness directly — conformance suite fails any definition whose replay diverges, which is exactly what un-audited randomness causes.

## 9. Recovery & void+refund

**Crash recovery** (instance death, Redis loss, deploy): on match load with no hot state — load latest `game_snapshots` row, replay `game_events` with `seq >` snapshot seq through `reduce`/`onTimeout` (draws replayed from `rng_draws`, not redrawn), rehydrate Redis, reschedule timers from `engine_timers` (past-due timers fire immediately in seq order), rebroadcast current playerViews. Deterministic reducers make this exact.

**Void + refund** — when replay fails (corrupt/impossible state, definition version unavailable §11, or admin void):
1. Match → `voided`; `match_voided` event appended with reason.
2. Wallet refund: `match_escrow` → each participant's original buy-in (poker refines this to stacks-as-of-hand-start — see `poker.md §10`), idempotent by matchId, escrow zeroes out.
3. Hash-chained audit-log entry (rule 15: game voids are audited) + risk-engine notification (void patterns are a fraud signal).
Void is the universal safe exit: **no code path abandons escrow**.

## 10. Kill-switch handling (per game)

Platform flag per game code (`platform` module). Modes: `active`; **`draining`** — refuse new matches (matchmaking stops offering; engine rejects `created` handoffs), in-flight matches finish normally; `disabled` — additionally void-and-refund in-flight matches (admin action, audited). Default operational action is drain; hard-disable is for incidents. Engine checks the flag (Redis-cached, short TTL, fail-closed) at match creation and at action authz.

## 11. Version pinning

A match is pinned at creation to the exact `game_definitions` (code, version) that formed it and uses that reducer for its whole life — including recovery replay. Deploying version N+1: N is marked `draining`, new matches pin N+1, N's code stays deployed until its in-flight matches settle (short, since matches are minutes-long; poker enforces pinning per hand, letting long table sessions migrate between hands). If a pinned version is genuinely gone at recovery time → void+refund path. Consequence: game modules keep old reducer versions loadable until drained — release process rule, checked in CI.

## 12. Engine-level invariants (enforced in engine code + tests, not per game)

1. No state transition without a committed `game_events` row (broadcast strictly after commit).
2. `playerView` is the **only** serialization that ever reaches a client — raw `GameState` has no transport path (rule 2: hidden information).
3. Games cannot import wallet/ledger modules (lint rule + module-boundary test); money moves only via §7.
4. `seq` per match is gapless and unique (PG constraint).
5. Every RNG draw is logged and tied to an event (§8).
6. Settlement and void are idempotent by matchId; escrow balance is zero after either.
7. Reducer determinism: replay of (snapshot + events + logged draws) reproduces byte-identical state.

## 13. Conformance test suite (P6 deliverable, run by every game in CI)

Given any `GameDefinition`, asserts: meta/config-schema validity; init→reduce→terminal reachable with generated valid action sequences; **every** invalid/out-of-turn/malformed action rejected without state change; playerView leaks nothing (serialize views for each player, diff against a game-declared hidden-field manifest, and property-test that no non-owner view ever contains another player's hidden data); determinism (replay identity, §12.7); `settle` output sums to escrow for all reachable terminal states; timeout handling from every waiting state; crash-recovery drill (kill mid-sequence at random points → resume or void with ledger intact); settlement idempotency (double-invoke no-ops). Coin-duel (P6 fixture) exists to keep this suite honest before P8/P9.

## 14. Metrics & observability

Per match: duration, actions count, reduce latency (p50/p99), events/sec, snapshot lag, recovery occurrences + replay depth, void count by reason. Per game code: active matches, settlement latency, settlement failures (alert), RNG draws/min, kill-switch state. Escrow-vs-open-matches reconciliation (wallet job) is the cross-domain financial alarm. All logs matchId-tagged, no PII; traces span action→commit→broadcast.

## 15. Phase mapping

**P6** everything above incl. coin-duel + conformance suite; **P7** consumes discovery + match handoff; **P8/P9** first real definitions; **P10** consumes void/risk signals; **P14** recovery + settlement chaos drills at load; **P18** certified RNG swap + certification per ADR-016.
