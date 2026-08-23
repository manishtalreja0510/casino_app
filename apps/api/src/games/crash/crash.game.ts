import type {
  GameAction,
  GameContext,
  GameDefinition,
  GamePlayer,
  ReduceResult,
  SettlementInstruction,
} from '@casino/contracts';
import { parseCrashConfig } from './crash.config';
import {
  BASE_X100,
  GROWTH_PER_MILLE,
  TICK_MS,
  crashPointFromSeed,
  msToReach,
  multiplierAtElapsed,
  multiplierAtTick,
  payoutFor,
  ticksToReach,
} from './crash.math';

/**
 * `crash` — the first shipped game (P8, OQ-05).
 *
 * A round is one engine match. Players bet during the match's `created` window, the
 * multiplier rises from 1.00× when the match starts, and the round ends at a crash point
 * fixed *before* betting opened and committed to publicly. Cash out first and you keep
 * stake × multiplier; ride past the crash and the stake goes to the house.
 *
 * Three things make it safe to run against untrusted clients:
 *
 *  - **The curve is a pure function of elapsed time**, so the "current multiplier" is not
 *    a thing the server broadcasts and hopes clients respect. It is recomputed from the
 *    recorded clock every time a cash-out is priced. A client showing 9.9× cannot cash out
 *    at 9.9× unless the server's own arithmetic agrees.
 *  - **The outcome is fixed before any bet exists** and published as a hash. The server
 *    cannot pick a crash point after seeing what people staked, and anyone can check that
 *    afterwards.
 *  - **The crash timer is a convenience, not the authority.** A cash-out arriving after
 *    the crash point is refused by comparing multipliers, so a timer that fires late
 *    cannot turn a losing ride into a win.
 */

export interface CrashState {
  phase: 'flying' | 'crashed';
  /** Recorded clock read at lift-off. Every multiplier is measured from here. */
  startedAt: number;
  /** Secret until `phase === 'crashed'` — `playerView` is what keeps it that way. */
  crashPointX100: number;
  /** Milliseconds from lift-off to the crash. Derived; stored so recovery can re-arm. */
  crashAtMs: number;
  maxMultiplierX100: number;
  /** userId → the multiplier they locked in. Absent means still riding, or busted. */
  cashOuts: Record<string, number>;
}

export const CRASH_TIMER_ID = 'crash';

/** A player's auto-cash-out target, fixed at bet time and honoured even if they vanish. */
function autoTargetFor(player: GamePlayer): number | null {
  const raw = (player.meta as Record<string, unknown> | undefined)?.autoCashOutX100;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= BASE_X100) return null;
  return raw;
}

function configOf(ctx: GameContext) {
  return parseCrashConfig(ctx.config).config;
}

export const crash: GameDefinition<CrashState> = {
  meta: {
    code: 'crash',
    name: 'Crash',
    version: 1,
    // One player is a real round: Crash is social, not competitive — you play against the
    // curve, and the others are company rather than opponents.
    minPlayers: 1,
    maxPlayers: 200,
    // No per-turn deadline. The round's only deadline is the crash itself, which
    // `pendingTimer` arms.
    turnTimeoutMs: 0,
    mode: 'rounds',
    banking: 'house',
    maxPayoutX100: 10_000,
  },

  init(ctx: GameContext): CrashState {
    const config = configOf(ctx);
    const serverSeed = typeof ctx.config.serverSeed === 'string' ? ctx.config.serverSeed : '';
    if (!serverSeed) {
      // Without a seed there is no committed outcome, and an uncommitted outcome is
      // exactly the thing this game exists to rule out.
      throw new Error('crash round opened without a server seed');
    }

    const crashPointX100 = crashPointFromSeed(
      serverSeed,
      config.houseEdgeBps,
      config.maxMultiplierX100,
    );

    return {
      phase: 'flying',
      startedAt: ctx.now(),
      crashPointX100,
      crashAtMs: msToReach(crashPointX100, config.maxMultiplierX100),
      maxMultiplierX100: config.maxMultiplierX100,
      cashOuts: {},
    };
  },

  reduce(ctx: GameContext, state: CrashState, action: GameAction): ReduceResult<CrashState> {
    if (action.type !== 'cashout') throw new Error(`Unknown action "${action.type}"`);

    const player = ctx.players.find((candidate) => candidate.userId === action.userId);
    if (!player) throw new Error('You are not in this round');
    if (state.phase !== 'flying') throw new Error('This round has already crashed');
    if (state.cashOuts[action.userId] !== undefined) throw new Error('You have already cashed out');

    const multiplierX100 = multiplierAtElapsed(
      ctx.now() - state.startedAt,
      state.maxMultiplierX100,
    );

    // The authoritative check, and deliberately not "has the crash timer fired yet".
    // Timers drift; this comparison does not. A cash-out that arrives after the curve
    // passed the crash point is a losing ride even if the crash event is still in flight.
    if (multiplierX100 >= state.crashPointX100) {
      throw new Error('Too late — this round has already crashed');
    }

    return {
      state: { ...state, cashOuts: { ...state.cashOuts, [action.userId]: multiplierX100 } },
      // Cash-outs are public: watching other players bail is most of what makes the game
      // social, and there is nothing hidden about a decision already made.
      events: [
        {
          type: 'player:cashed_out',
          payload: {
            userId: action.userId,
            multiplierX100,
            payout: payoutFor(player.stake, multiplierX100),
          },
        },
      ],
    };
  },

  /**
   * The crash.
   *
   * Auto-cash-outs are resolved here rather than at the moment each target is passed: the
   * money is identical either way (the target multiplier is a fixed point on a fixed
   * curve), and resolving them in one place means a player who set a target and then lost
   * their connection is paid by arithmetic rather than by anything having to reach them.
   */
  onTimeout(ctx: GameContext, state: CrashState, timerId: string): ReduceResult<CrashState> {
    if (timerId !== CRASH_TIMER_ID || state.phase !== 'flying') {
      return { state, events: [] };
    }

    const cashOuts = { ...state.cashOuts };
    for (const player of ctx.players) {
      if (cashOuts[player.userId] !== undefined) continue;

      const target = autoTargetFor(player);
      if (target === null) continue;

      const locked = multiplierAtTick(
        ticksToReach(target, state.maxMultiplierX100),
        state.maxMultiplierX100,
      );
      // A target the curve never reached before crashing is simply a ride that lost.
      if (locked < state.crashPointX100) cashOuts[player.userId] = locked;
    }

    return {
      state: { ...state, phase: 'crashed', cashOuts },
      events: [
        {
          type: 'round:crashed',
          payload: { crashPointX100: state.crashPointX100, cashOuts },
        },
      ],
      timer: null,
    };
  },

  /**
   * What one player sees.
   *
   * The crash point and the server seed are in state and config respectively, and neither
   * leaves this function before the round crashes. That is the whole information-hiding
   * story for this game, and it is why `playerView` is the only path to a client.
   */
  playerView(ctx: GameContext, state: CrashState, userId: string): Record<string, unknown> {
    const player = ctx.players.find((candidate) => candidate.userId === userId);
    const cashedOutAtX100 = state.cashOuts[userId] ?? null;

    return {
      ...publicRound(ctx, state),
      yourBet: player
        ? {
            amount: player.stake,
            autoCashOutX100: autoTargetFor(player),
            cashedOutAtX100,
            payout:
              state.phase === 'crashed'
                ? cashedOutAtX100 === null
                  ? 0
                  : payoutFor(player.stake, cashedOutAtX100)
                : null,
          }
        : null,
    };
  },

  publicView(ctx: GameContext, state: CrashState): Record<string, unknown> {
    return publicRound(ctx, state);
  },

  /**
   * The round's own deadline.
   *
   * Armed at lift-off, and re-armed after a restart with whatever flight time is left —
   * which is the only reason a round that outlived its process still ends.
   */
  pendingTimer(ctx: GameContext, state: CrashState): { id: string; delayMs: number } | null {
    if (state.phase !== 'flying') return null;
    const remaining = state.startedAt + state.crashAtMs - ctx.now();
    return { id: CRASH_TIMER_ID, delayMs: Math.max(0, remaining) };
  },

  isTerminal(state: CrashState): boolean {
    return state.phase === 'crashed';
  },

  /**
   * Payouts.
   *
   * House-banked (`meta.banking`), so the total may exceed escrow — one player at 5×
   * is paid five times their stake regardless of what anyone else lost. The wallet draws
   * the difference from the house float; this function's only job is the arithmetic.
   */
  settle(ctx: GameContext, state: CrashState): SettlementInstruction[] {
    return ctx.players.map((player) => {
      const multiplierX100 = state.cashOuts[player.userId];
      return {
        userId: player.userId,
        amount: multiplierX100 === undefined ? 0 : payoutFor(player.stake, multiplierX100),
      };
    });
  },
};

/** The part of a round everybody may see — bets included, secrets excluded. */
function publicRound(ctx: GameContext, state: CrashState): Record<string, unknown> {
  const crashed = state.phase === 'crashed';

  // While flying, the live multiplier is clamped to the crash point: between the crash
  // and the timer firing there is no honest higher number to show, and showing one would
  // invite a cash-out that is about to be refused.
  const live = multiplierAtElapsed(ctx.now() - state.startedAt, state.maxMultiplierX100);
  const multiplierX100 = crashed ? state.crashPointX100 : Math.min(live, state.crashPointX100);

  return {
    phase: state.phase,
    startedAt: state.startedAt,
    // The curve's shape, sent rather than assumed.
    //
    // A crash client has to animate a rising number between server updates, and the only
    // honest way to do that without a second implementation of the rules is to render the
    // curve the server describes. These two numbers are that description. They are for
    // *drawing*: no payout is ever computed from them, and every value the server sends
    // overrides whatever the client had drawn (rules 2, 21).
    tickMs: TICK_MS,
    growthPerMille: GROWTH_PER_MILLE,
    multiplierX100,
    maxMultiplierX100: state.maxMultiplierX100,
    crashedAtX100: crashed ? state.crashPointX100 : null,
    serverSeed: crashed && typeof ctx.config.serverSeed === 'string' ? ctx.config.serverSeed : null,
    commitment: typeof ctx.config.commitment === 'string' ? ctx.config.commitment : null,
    bets: ctx.players.map((player) => ({
      userId: player.userId,
      amount: player.stake,
      cashedOutAtX100: state.cashOuts[player.userId] ?? null,
      payout: crashed
        ? payoutFor(player.stake, state.cashOuts[player.userId] ?? 0)
        : null,
    })),
  };
}
