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
}

export interface GamePlayer {
  readonly userId: string;
  /** Seat index, stable for the life of the match. */
  readonly seat: number;
  /** Buy-in already held in escrow, in integer minor units. */
  readonly stake: number;
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

  isTerminal(state: TState): boolean;

  /** Payouts for a terminal match. Games never touch wallets themselves (rule 10). */
  settle(ctx: GameContext, state: TState): readonly SettlementInstruction[];
}
