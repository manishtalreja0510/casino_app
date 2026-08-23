/**
 * The game contract (ADR-009, `docs/01-architecture/game-architecture.md`).
 *
 * Every game — the casino game in P8, poker in P9, and the ~8 after them — implements
 * this one interface and gets authoritative state, durable history, crash recovery,
 * audited randomness, timers, and settlement without implementing any of them itself.
 *
 * The reducer is **pure**: no I/O, no clock, no randomness except through `ctx`. That is
 * not a style preference — it is what makes replaying the event log produce byte-identical
 * state, which is the basis of both crash recovery and dispute resolution.
 */

export type MatchStatus =
  | 'created'
  | 'starting'
  | 'in_progress'
  | 'settling'
  | 'settled'
  | 'voided';

/**
 * How players are admitted to a match (ADR-023).
 *
 * `matchmade` — a queue forms a fixed roster and everyone is charged in one transaction,
 * or nobody is. `rounds` — a match is opened empty, players buy in independently during a
 * betting window, and it starts with whoever paid. The difference is deliberate: in a
 * duel one player who cannot pay means there is no game, while in a round game it means
 * one fewer better.
 */
export type GameMode = 'matchmade' | 'rounds';

/**
 * Where winnings come from (ADR-024).
 *
 * `pooled` — players are paid out of each other's stakes; payouts can never exceed
 * escrow. `house` — the house is the counterparty, so a payout may exceed escrow and the
 * difference is drawn from the house float. The engine routes settlement on this field;
 * it never branches on a game's code.
 */
export type GameBanking = 'pooled' | 'house' | 'table';

export interface GameMeta {
  /** Stable identifier, e.g. `coin-duel`. Used in kill-switch keys and match records. */
  readonly code: string;
  readonly name: string;
  /** Bumped on any rule change. In-flight matches keep the version they started on. */
  readonly version: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Default per-turn deadline in milliseconds; 0 means the game has no turn timer. */
  readonly turnTimeoutMs: number;
  /** Defaults to `matchmade` — the model every game had before ADR-023. */
  readonly mode?: GameMode;
  /** Defaults to `pooled` — the model every game had before ADR-024. */
  readonly banking?: GameBanking;
  /**
   * Worst-case payout for a player, as a multiple of their stake ×100, for house-banked
   * games. Exposure control needs a bound the platform can compute *before* a round runs;
   * a game that cannot state one has no business being house-banked.
   */
  readonly maxPayoutX100?: number;
}

export interface GamePlayer {
  readonly userId: string;
  /** Seat index, stable for the life of the match. */
  readonly seat: number;
  /** Buy-in already held in escrow, in integer minor units. */
  readonly stake: number;
  /**
   * Per-player data fixed at join time, before the match starts — a Crash auto-cash-out
   * target, a poker sit-out preference. Part of the roster rather than of state because
   * it is decided before `init` runs, and it is replayed with the roster.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Everything a reducer may touch beyond its own state.
 *
 * Anything non-deterministic lives here so that replay can substitute recorded values:
 * `random` returns draws that were recorded the first time, `now` is the recorded
 * timestamp. A game reaching for `Math.random()` or `Date.now()` directly breaks recovery.
 */
export interface GameContext {
  readonly matchId: string;
  readonly players: readonly GamePlayer[];
  readonly config: Readonly<Record<string, unknown>>;
  /** Integer in [0, max). Audited and replayable. */
  random(max: number, purpose: string): number;
  /** Deterministic during replay — never wall-clock time inside a reducer. */
  now(): number;
}

export interface GameAction {
  readonly type: string;
  readonly userId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface GameEventOut {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * When set, this event is delivered ONLY to these users. Hidden information (a dealt
   * hole card) must carry the owner here — the engine will not broadcast it.
   */
  readonly onlyTo?: readonly string[];
}

export interface ReduceResult<TState> {
  readonly state: TState;
  readonly events: readonly GameEventOut[];
  /** Arms a turn deadline; omit to leave any existing timer alone. */
  readonly timer?: { readonly id: string; readonly delayMs: number } | null;
}

/** How much each player is paid from escrow. The engine posts the ledger movement. */
export interface SettlementInstruction {
  readonly userId: string;
  /** Integer minor units. Must not exceed what escrow holds; the wallet enforces it. */
  readonly amount: number;
}

export interface GameDefinition<TState = unknown> {
  readonly meta: GameMeta;

  /** Initial state. Called once, its result persisted as the first event. */
  init(ctx: GameContext): TState;

  /**
   * Applies an action. MUST reject anything invalid by throwing — a rejected action
   * leaves state untouched and is never persisted.
   */
  reduce(ctx: GameContext, state: TState, action: GameAction): ReduceResult<TState>;

  /** A server-side deadline expired. The server decides the consequence, not the client. */
  onTimeout(ctx: GameContext, state: TState, timerId: string): ReduceResult<TState>;

  /**
   * The ONLY serialisation of state toward a client.
   *
   * Everything a player may see, and nothing else. The engine never sends raw state —
   * so a game cannot leak hidden information by forgetting to filter (rule 2).
   */
  playerView(ctx: GameContext, state: TState, userId: string): Readonly<Record<string, unknown>>;

  /**
   * What anyone watching the match may see — no player identity involved.
   *
   * Round games have spectators and a shared room; this is the only state that reaches
   * it. A game that omits it simply has no public view, and nothing is broadcast.
   */
  publicView?(ctx: GameContext, state: TState): Readonly<Record<string, unknown>>;

  /**
   * The deadline that should be armed for this state *right now*.
   *
   * `ReduceResult.timer` covers deadlines created by a move. This covers the two moments
   * where there is no move to carry one: immediately after `init`, and after a restart
   * has replayed a match back into memory. Without it a game whose clock runs on its own
   * — Crash in flight — resumes frozen.
   *
   * May read `ctx.now()`: it is never called during replay.
   */
  pendingTimer?(ctx: GameContext, state: TState): { readonly id: string; readonly delayMs: number } | null;

  isTerminal(state: TState): boolean;

  /** Payouts for a terminal match. Games never touch wallets themselves (rule 10). */
  settle(ctx: GameContext, state: TState): readonly SettlementInstruction[];

  /**
   * For `banking: 'table'` games: how much leaves the table for the house on this match.
   *
   * The only ledger movement a table-banked match makes. Everything else — who won which
   * pot, how the stacks changed — is game state sitting inside an escrow that already
   * holds it, so there is nothing for the ledger to do. Required for table-banked games
   * and ignored for the others; the conformance suite enforces that.
   */
  rakeFor?(ctx: GameContext, state: TState): number;
}
