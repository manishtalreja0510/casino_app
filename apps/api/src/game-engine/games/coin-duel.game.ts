import type {
  GameAction,
  GameContext,
  GameDefinition,
  ReduceResult,
  SettlementInstruction,
} from '@casino/contracts';

/**
 * `coin-duel` — the engine's reference game. **Development fixture, never shipped.**
 *
 * Its purpose is to exercise every hook of the contract in the simplest game that can:
 * turn order, a hidden per-player value, a server-drawn random outcome, a turn deadline,
 * a terminal condition, and a settlement. P8 and P9 are real games; this one exists so
 * the engine's guarantees are tested independently of any of them.
 *
 * Rules: each player secretly picks heads or tails, in seat order. Once both have picked,
 * the server flips a coin; players who matched the flip split the pot. Failing to pick in
 * time picks for you (the server decides, not the client).
 */

export interface CoinDuelState {
  /** Seat index whose turn it is; null once every player has picked. */
  turn: number | null;
  /** userId → their pick. Hidden from everyone else until the flip. */
  picks: Record<string, 'heads' | 'tails'>;
  flip: 'heads' | 'tails' | null;
  winners: string[];
  pot: number;
}

const TURN_TIMEOUT_MS = 15_000;

export const coinDuel: GameDefinition<CoinDuelState> = {
  meta: {
    code: 'coin-duel',
    name: 'Coin Duel (reference)',
    version: 1,
    minPlayers: 2,
    maxPlayers: 2,
    turnTimeoutMs: TURN_TIMEOUT_MS,
  },

  init(ctx: GameContext): CoinDuelState {
    return {
      turn: 0,
      picks: {},
      flip: null,
      winners: [],
      pot: ctx.players.reduce((sum, player) => sum + player.stake, 0),
    };
  },

  reduce(ctx: GameContext, state: CoinDuelState, action: GameAction): ReduceResult<CoinDuelState> {
    if (action.type !== 'pick') throw new Error(`Unknown action "${action.type}"`);

    const player = ctx.players.find((candidate) => candidate.userId === action.userId);
    if (!player) throw new Error('You are not in this match');
    if (state.flip !== null) throw new Error('This match is already decided');
    if (state.picks[action.userId]) throw new Error('You have already picked');
    if (state.turn !== player.seat) throw new Error('It is not your turn');

    const choice = action.payload?.choice;
    if (choice !== 'heads' && choice !== 'tails') throw new Error('Pick heads or tails');

    return applyPick(ctx, state, action.userId, choice);
  },

  /**
   * A player who runs out of time gets a pick made for them, server-side. Stalling must
   * not be a way to avoid an outcome, and the choice must not be the client's to make.
   */
  onTimeout(ctx: GameContext, state: CoinDuelState, timerId: string): ReduceResult<CoinDuelState> {
    if (state.turn === null || state.flip !== null) return { state, events: [] };

    const player = ctx.players.find((candidate) => candidate.seat === state.turn);
    if (!player) return { state, events: [] };

    const choice = ctx.random(2, `timeout-pick:${timerId}`) === 0 ? 'heads' : 'tails';
    return applyPick(ctx, state, player.userId, choice, true);
  },

  /**
   * A player sees their own pick and never anyone else's — until the flip reveals them.
   * This is the hidden-information mechanic the contract exists to enforce; poker's hole
   * cards (P9) are the same shape.
   */
  playerView(ctx: GameContext, state: CoinDuelState, userId: string): Record<string, unknown> {
    return {
      turn: state.turn,
      yourPick: state.picks[userId] ?? null,
      // Before the flip: who has picked, never what they picked.
      picked: Object.keys(state.picks),
      picks: state.flip === null ? null : state.picks,
      flip: state.flip,
      winners: state.winners,
      pot: state.pot,
    };
  },

  isTerminal(state: CoinDuelState): boolean {
    return state.flip !== null;
  },

  settle(ctx: GameContext, state: CoinDuelState): SettlementInstruction[] {
    if (state.winners.length === 0) {
      // Nobody matched: stakes are returned. The engine forbids paying out more than
      // escrow holds, and inventing a house win here would be a rule this game has no
      // business making up.
      return ctx.players.map((player) => ({ userId: player.userId, amount: player.stake }));
    }

    const share = Math.floor(state.pot / state.winners.length);
    const remainder = state.pot - share * state.winners.length;

    return state.winners.map((userId, index) => ({
      userId,
      // Integer division leaves a remainder; give it to the first winner rather than
      // rounding, so the payouts sum to exactly the pot (rule 4 — no lost minor units).
      amount: index === 0 ? share + remainder : share,
    }));
  },
};

function applyPick(
  ctx: GameContext,
  state: CoinDuelState,
  userId: string,
  choice: 'heads' | 'tails',
  automatic = false,
): ReduceResult<CoinDuelState> {
  const picks = { ...state.picks, [userId]: choice };
  const everyonePicked = ctx.players.every((player) => picks[player.userId]);

  if (!everyonePicked) {
    const nextSeat = ctx.players.find((player) => !picks[player.userId])!.seat;
    return {
      state: { ...state, picks, turn: nextSeat },
      events: [
        // The fact of a pick is public; the pick itself goes only to its owner.
        { type: 'player:picked', payload: { userId, automatic } },
        { type: 'your:pick', payload: { choice }, onlyTo: [userId] },
      ],
      timer: { id: `turn:${nextSeat}`, delayMs: TURN_TIMEOUT_MS },
    };
  }

  const flip = ctx.random(2, 'coin-flip') === 0 ? 'heads' : 'tails';
  const winners = ctx.players
    .filter((player) => picks[player.userId] === flip)
    .map((player) => player.userId);

  return {
    state: { ...state, picks, turn: null, flip, winners },
    events: [
      { type: 'player:picked', payload: { userId, automatic } },
      { type: 'coin:flipped', payload: { flip, picks, winners } },
    ],
    timer: null,
  };
}
