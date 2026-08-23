# Game Architecture — Engine & the GameDefinition Contract

The platform's most important extension point. Every game — Crash-style rounds, poker tables, all ~10 planned — is a plug-in implementing one contract; the engine (`game-engine` module) owns lifecycle, persistence, timers, RNG, and settlement. Games contain game rules and nothing else. ADR-006 (server-authoritative game architecture), ADR-009 (modular game contract). Built in P6, first consumed by shipped games in P8 (casino game #1, OQ-05) and P9 (poker, OQ-07). Transport: `docs/01-architecture/realtime-architecture.md`. Money: `docs/02-domains/wallet.md`, rules 4–7, 10.

## 1. Design rationale (ADR-006 / ADR-009)

**Problem.** ~10 games must ship on one platform without each re-implementing (and re-breaking) persistence, recovery, settlement, timers, fairness, and information hiding — the parts where bugs cost money or trust.

**Chosen.** A server-side, event-sourced, reducer-style contract: games are (mostly) pure functions over state; the engine owns every effect (I/O, money, timers, RNG audit, broadcast).

**Alternatives.** (a) *Free-form game services* — each game its own module with direct DB/wallet access: fastest first game, then N divergent recovery/settlement implementations, and rule 10 becomes unenforceable. (b) *Actor-per-table with in-memory truth* (classic game-server style): great latency, but memory-as-truth conflicts with rule 2/ADR-004 — crash recovery and dispute evidence must come from PG. (c) *Third-party game aggregator content*: irrelevant for our own multiplayer games and forfeits the differentiator.

**Why.** Pure reducers are property-testable and replayable (recovery = replay); a single choke point enforces information hiding (`playerView`) and the money boundary (`settle`); a conformance suite (§13) can certify any game against the platform's invariants before it ships.

**Trade-offs.** Games must fit the reducer shape (long-lived tables like poker need modeling discipline — the hand is the natural event-sourced unit); the contract is a hard API to change once N games implement it, hence versioning (§11). Full rationale: ADR-006, ADR-009.

## 2. The `GameDefinition` contract

Canonical interfaces live in `packages/contracts` (TypeScript; sketch — authoritative shape is the contracts package):

```ts
interface GameDefinition<S extends GameState, A extends GameAction, C extends GameConfig> {
  meta: {
    code: string;                    // 'poker_nlhe', 'crash', 'coin_duel'
    name: string;
    version: number;                 // game-logic version, see §11
    minPlayers: number;
    maxPlayers: number;
    turnTimers: TurnTimerConfig;     // defaults + allowed ranges
    configSchema: JsonSchema;        // validates C (stakes, timers, rounds)
    disconnectPolicy: DisconnectPolicyConfig; // grace, sit-out/auto-act rules
  };

  init(ctx: GameCtx, players: PlayerRef[], config: C): S;

  // Server-side pure-ish reducer. MUST validate every action (actor, turn,
  // legality, amounts) and throw typed rejections for invalid input.
  reduce(ctx: GameCtx, state: S, action: A): { state: S; events: GameEvent[] };

  // Server-authoritative timers (turn clocks, round ticks, grace expiry).
  onTimeout(ctx: GameCtx, state: S, timerId: TimerId): { state: S; events: GameEvent[] };

  // THE information-hiding boundary — the only serialization path to clients.
  playerView(state: S, playerId: PlayerId | null): PlayerView; // null = spectator/public

  isTerminal(state: S): boolean;

  // Pure description of money movement; engine applies it via wallet escrow.
  settle(state: S): SettlementInstruction[]; // [{accountRef, amount, kind: 'payout'|'rake'|'refund'}]
}

interface GameCtx {
  matchId: string;                   // UUIDv7
  meta: MatchMeta;                   // match metadata: players, stakes, config (game-engine.md §4)
  rng: RngService;                   // §8 — CSPRNG draws, audit-logged
  clock: Clock;                      // ctx.clock.now() — never Date.now()
  logger: GameLogger;                // structured, no PII (rule 15)
  scheduleTimer(id: TimerId, fireAt: Date): void;   // recorded as events
  cancelTimer(id: TimerId): void;
}
```

Contract rules:

- `init`/`reduce`/`onTimeout` are deterministic given `(state, input, ctx.rng draws, ctx.clock reads)` — all nondeterminism flows through `ctx` and is captured in the event log, which is what makes replay (§6) exact.
- Games perform **no I/O**: no DB, no Redis, no network, no wallet (rule 10 ⛔). The returned `events[]` are the only side-channel; the engine persists and broadcasts them.
- `reduce` treats every action as hostile input (rule 1): wrong actor, out of turn, malformed amount, replayed `actionId` — all rejected with typed errors, surfaced as ack errors on the socket (`realtime-architecture.md §7`).
- Amounts anywhere in state/settlement are integer minor units + currency code (rule 4).

## 3. Lifecycle state machine

Engine-owned; games never transition lifecycle themselves.

```
created ── all players escrowed ──► starting ── init() applied ──► in_progress
                                        │                              │
                                        │                    isTerminal(state) == true
                                        ▼                              ▼
                                     voided ◄── unrecoverable ──── settling
                                 (refund via                           │
                                  reversal,                 settle() applied via wallet,
                                  audited)                    idempotent by matchId
                                        ▲                              ▼
                                        └──────────────────────────► settled
```

| Transition | Rule |
|---|---|
| `created → starting` | matchmaking/table module created the match record (PG); engine collects buy-ins: each player's wallet → `match_escrow` account (idempotent per player+match). All-in or timeout → abort to `voided` (full refunds). |
| `starting → in_progress` | `init()` executed, initial state persisted (event 0 + snapshot 0), timers armed, first broadcast. |
| `in_progress → settling` | first observation of `isTerminal(state) === true` after a `reduce`/`onTimeout`. No further actions accepted. |
| `settling → settled` | `settle(state)` output applied through the wallet domain service in one ledger transaction, idempotent by matchId; escrow zeroes out (canonical invariant). Retried until success — `settling` is durable. |
| `* → voided` | admin void, kill-switch drain, or unrecoverable crash (§6). All escrowed funds returned via reversal transactions; audit-logged (rule 15); risk engine notified. |

Terminal states are `settled` and `voided` — both leave `match_escrow` at exactly zero. Reconciliation cross-checks escrow vs open matches on schedule (rule 9).

## 4. Runtime & action flow

1. Client action arrives on `/game` (validated, rate-limited, deduped by `actionId` — `realtime-architecture.md §7, §10`).
2. Engine acquires the per-match processing lock (Redis lock + PG fencing token — matches are single-writer), loads hot state (Redis; fallback §6).
3. `reduce(ctx, state, action)` → `{state', events}`.
4. **Persist first**: events appended to `game_events` (PG) in one transaction — the commit is the moment the action "happened".
5. Redis hot state and ring buffer updated; events broadcast — shared-room events to `match:{id}`/`table:{id}`, per-player data via `playerView` deltas to `user:{id}` rooms; timers (re)armed via the P5 framework.
6. Ack to the acting client with the new seq.

`onTimeout` follows the same path with the timer firing as input (idempotent: stale `timerId` against advanced state is a no-op by contract).

## 5. Persistence model

| Store | Contents | Role |
|---|---|---|
| PG `game_events` | append-only: `(match_id, event_seq, type, payload jsonb, rng_draw_refs, created_at timestamptz)` — every action, timeout, RNG draw reference, lifecycle transition | **truth** — recovery, disputes, collusion analysis (P10), audits |
| PG `game_snapshots` | periodic full-state snapshots `(match_id, event_seq, state jsonb, game_version)` — every N events / M seconds / at hand boundaries (poker: snapshot per hand start) | replay-cost bound |
| PG `matches` | lifecycle row: status, game code+version, config, players, escrow refs | join point for wallet/matchmaking/admin |
| Redis | hot state (latest reduced state), per-room event ring buffer (~2 min), match processing locks | latency cache only — rebuildable, losable (rule 7) |

Snapshots are an optimization; `game_events` alone must reconstruct any state (conformance-tested, §13). Full state (including hidden info) exists only server-side; hidden fields never appear in broadcast payloads — client-bound serialization goes exclusively through `playerView` (§7).

## 6. Crash recovery

On engine worker start, lock takeover, or hot-state miss for an `in_progress`/`settling` match:

1. Load latest snapshot for `matchId` (else start from event 0 with recorded `init` inputs).
2. Replay `game_events` with `event_seq >` snapshot seq through `reduce`/`onTimeout` on the **pinned game version** (§11), with RNG draws and clock reads replayed from the log (never re-drawn).
3. Verify: replay reaches the logged head cleanly; state hash matches the last persisted state hash.
4. Re-arm outstanding timers from recovered state (expired-during-downtime timers fire immediately, in order). Resume accepting actions; clients resync via the resume protocol (`realtime-architecture.md §8`).
5. Match found in `settling` → re-apply `settle` (idempotent by matchId; already-applied is a no-op).

**Unrecoverable** (replay diverges, log corrupt/incomplete, game version unavailable): the match is **voided** — buy-ins returned to players via reversal transactions through the wallet service, transition audited with the failure reason (rule 15), on-call alerted. Poker refines this at hand granularity: an unrecoverable in-flight hand voids that hand and restores stacks as of hand start; the table survives (`docs/02-domains/poker.md`, P9). We never guess state where money is concerned: recover exactly, or void and refund.

## 7. Information hiding — `playerView`

`playerView(state, playerId)` is the **only** path by which game state reaches any client — initial sync, per-event deltas, resume replay, full resync, and spectators (`playerId = null`) alike. Nothing else in the platform serializes `GameState` outward. Consequences:

- Hole cards, hidden RNG pre-images (commit-reveal, §8), and opponents' private prompts structurally cannot leak via "forgot to filter" bugs in transport code — the filter is the contract surface itself, per game, where the game's author knows what is secret (rule 2 ⛔).
- The conformance suite (§13) and P9's adversarial protocol tests attack exactly this boundary (requesting others' views, diffing broadcast payloads for hidden fields).
- Logs and error reports carry state references (matchId, event_seq), never raw state.

## 8. RNG service (ADR-016, PROPOSED pending OQ-01)

`ctx.rng` is a port (`RngService`), never `Math.random`/direct crypto calls in game code:

- **Now:** Node CSPRNG (`crypto.randomBytes`-backed) with unbiased range/shuffle helpers.
- **Every draw is audit-logged**: `(match_id, event_seq, draw_id, purpose, algorithm, value-or-committed-hash)` — draws are events, which is what makes replay deterministic and disputes answerable.
- **Certified-RNG swap path:** jurisdiction may require a certified RNG (GLI-19-style; lab choice blocked on OQ-01). Because games only see the port, certification swaps the adapter, not the games — the reason `RngService` exists.
- **Commit-reveal helper** for provably-fair games: engine commits `hash(seed‖salt)` before a round, reveals after — optional per game (Crash is the natural first user, per OQ-05 recommendation); the helper standardizes it so no game hand-rolls fairness crypto.

## 9. Turn timers & disconnects

Timers are declared by the game (`ctx.scheduleTimer` inside `init`/`reduce`/`onTimeout`) and executed by the P5 server timer framework (BullMQ delayed jobs / timer wheel, fenced — `realtime-architecture.md §9`); firings come back as `onTimeout`. Client countdowns are cosmetic renderings of deadlines in events; the server clock decides (rule 2).

Disconnects are policy, not plumbing: the realtime layer reports connection changes to the engine; the engine consults `meta.disconnectPolicy` and the game's own state (via injected actions/timers) to apply grace periods, sit-out, auto-fold/auto-act, or configurable behavior (casino game). The transport layer never decides game consequences.

## 10. Settlement through wallet escrow

Canonical money flow (rule 10 ⛔; `docs/02-domains/wallet.md`):

```
buy-in:   user wallet ──► match_escrow (per-match account)   [at created→starting]
settle:   match_escrow ──► winners' wallets + rake ──► house rake account
refund:   match_escrow ──► users, via reversal               [voided path]
```

Poker refines this per-match model to a **table-scoped escrow** (stacks persist across hand-matches; per-hand ledger movement is rake only) — `docs/02-domains/poker.md §5`.

- Games emit `SettlementInstruction[]` — pure data. The engine hands them to the wallet domain service, which applies them as **one ledger transaction, idempotent by matchId** (entries sum to zero, escrow ends at zero, rule 5/6).
- Engine validates instructions before applying: total ≤ escrowed amount, currency match, known accounts, rake within config. A game cannot mint money even by bug — invalid instructions fail settlement into an alerted, human-review state, not a partial payout.
- Games never import wallet types beyond `SettlementInstruction`; module boundaries enforce it (rule 20) and the conformance suite asserts no wallet access.

## 11. Versioning of game logic

`meta.version` pins semantics. Rules:

- Every match records `game_version` at `created`. **In-flight matches finish on the version they started on** — replay determinism (§6) requires bit-identical reducer behavior, so the engine's registry can hold multiple versions of a game's logic concurrently during rollout.
- A version bump is required for any change that alters `reduce`/`onTimeout`/`settle`/`init` outputs for identical inputs; pure additions (new config knob defaulting to old behavior) may keep the version with a recorded justification.
- Old versions are retired only when no non-terminal match references them (engine-enforced check); a needed-but-retired version at recovery time is an *unrecoverable* condition → void+refund (§6) — which is why retirement is gated, not manual.

## 12. Per-game configuration

`meta.configSchema` (JSON Schema, in `packages/contracts`) validates each game's config: stake tiers/min-max buy-in, timer durations, round pacing, seat counts, rake parameters (present from P9 but zeroed on `TST`), disconnect grace. Config instances live in PG under the `platform` module's config framework, are validated on write and at match creation, and are versioned — a match snapshots its config at `created`. Stake tiers feed matchmaking queue definitions (P7).

## 13. Adding a new game — checklist & conformance suite

Adding game N is the platform's repeatable act (P8 proves it once, P9 under maximum load). Checklist:

1. **Module**: `apps/api/src/games/<code>` NestJS module — contract implementation + registration with the engine registry; no own tables beyond game-specific config (module-owned-tables rule 20 still applies if any).
2. **Contract implementation**: `GameDefinition` per §2; config schema; disconnect policy.
3. **Conformance suite green** (below) + game-specific property tests (e.g. payout-table exactness vs RNG stream, side-pot laws).
4. **Kill-switch**: per-game flag wired (`platform` module) — flips to drain: no new matches, in-flight matches finish or void per policy (rule 16).
5. **UI components**: game screen as thin shell; any new visual components go into `ui_kit` (tokens only, rule 25), animations via intent-named wrappers (rule 26); flow added to router config + `docs/08-design/ui-flow-map.md`.
6. Game rules + fairness note doc; risk-engine review for game-specific abuse surface (P10).

**Conformance suite** (built in P6 against the dev-only `coin-duel` reference game; parameterized over any `GameDefinition`):

- *Determinism*: same inputs + recorded draws/clock ⇒ identical states/events; snapshot+replay from every prefix reproduces head state.
- *Hostile input*: out-of-turn, wrong-actor, malformed, replayed actions all rejected without state change.
- *Information hiding*: for random reachable states, `playerView(s, p)` contains no other player's hidden fields; broadcast payload diffing finds no hidden data.
- *Settlement invariants*: `isTerminal` ⇒ `settle` instructions balance against escrow exactly; settlement idempotent; kill-mid-match drills end in `settled` or `voided` with zero ledger drift.
- *Timers*: every scheduled timer is either fired or cancelled by terminal state; stale firings are no-ops.

A game that passes conformance inherits the platform's recovery, fairness-audit, and money guarantees by construction — that inheritance is the point of the contract (P6 acceptance: coin-duel end-to-end over WS, across restarts, zero drift).
