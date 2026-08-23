import type { GameContext, GamePlayer } from '@casino/contracts';
import { crash, CRASH_TIMER_ID, type CrashState } from './crash.game';
import {
  BASE_X100,
  TICK_MS,
  commitmentFor,
  crashPointFromSeed,
  multiplierAtTick,
  ticksToReach,
} from './crash.math';

const MAX = 10_000;
const EDGE_BPS = 300;
const T0 = 1_700_000_000_000;

/** A seed whose crash point is comfortably high, so a test can ride for a while. */
function seedCrashingAbove(minX100: number): string {
  for (let i = 0; i < 100_000; i++) {
    const seed = `seed-${i}`;
    if (crashPointFromSeed(seed, EDGE_BPS, MAX) >= minX100) return seed;
  }
  throw new Error('no suitable seed');
}

function makeCtx(options: {
  players: GamePlayer[];
  serverSeed: string;
  now?: number;
}): GameContext {
  return {
    matchId: 'test-round',
    players: options.players,
    config: {
      betMin: 100,
      betMax: 100_000,
      maxRoundStake: 1_000_000,
      maxHouseExposure: 100_000_000,
      bettingWindowMs: 7_000,
      interRoundMs: 5_000,
      houseEdgeBps: EDGE_BPS,
      maxMultiplierX100: MAX,
      serverSeed: options.serverSeed,
      commitment: commitmentFor(options.serverSeed),
    },
    random: () => {
      throw new Error('crash must not draw randomness — its outcome comes from the seed');
    },
    now: () => options.now ?? T0,
  };
}

const alice: GamePlayer = { userId: 'alice', seat: 0, stake: 1_000 };
const bob: GamePlayer = { userId: 'bob', seat: 1, stake: 2_000 };

describe('crash — round setup', () => {
  const seed = seedCrashingAbove(500);

  it('fixes the crash point from the committed seed, drawing no randomness', () => {
    const state = crash.init(makeCtx({ players: [alice], serverSeed: seed }));

    expect(state.phase).toBe('flying');
    expect(state.startedAt).toBe(T0);
    expect(state.crashPointX100).toBe(crashPointFromSeed(seed, EDGE_BPS, MAX));
    expect(state.crashAtMs).toBe(ticksToReach(state.crashPointX100, MAX) * TICK_MS);
  });

  it('refuses to open a round with no committed outcome', () => {
    const ctx = makeCtx({ players: [alice], serverSeed: '' });
    expect(() => crash.init(ctx)).toThrow(/server seed/i);
  });

  it('arms the crash deadline, and re-arms it with the time actually left', () => {
    const ctx = makeCtx({ players: [alice], serverSeed: seed });
    const state = crash.init(ctx);

    expect(crash.pendingTimer!(ctx, state)).toEqual({
      id: CRASH_TIMER_ID,
      delayMs: state.crashAtMs,
    });

    // A process that restarted 1s into the flight must arm the remainder, not the whole.
    const later = makeCtx({ players: [alice], serverSeed: seed, now: T0 + 1_000 });
    expect(crash.pendingTimer!(later, state)).toEqual({
      id: CRASH_TIMER_ID,
      delayMs: state.crashAtMs - 1_000,
    });

    // Past the deadline it fires immediately rather than scheduling into the past.
    const overdue = makeCtx({ players: [alice], serverSeed: seed, now: T0 + state.crashAtMs + 5_000 });
    expect(crash.pendingTimer!(overdue, state)!.delayMs).toBe(0);
  });
});

describe('crash — cashing out', () => {
  const seed = seedCrashingAbove(500);
  const players = [alice, bob];

  function flying(): { state: CrashState; ctx: GameContext } {
    const ctx = makeCtx({ players, serverSeed: seed });
    return { state: crash.init(ctx), ctx };
  }

  it('prices a cash-out from the server clock, not from anything the client sends', () => {
    const { state } = flying();
    const at = makeCtx({ players, serverSeed: seed, now: T0 + 10 * TICK_MS });

    const result = crash.reduce(at, state, {
      type: 'cashout',
      userId: 'alice',
      // A client claiming a multiplier is simply ignored: there is no field for it.
      payload: { multiplierX100: 9_999 },
    });

    expect(result.state.cashOuts.alice).toBe(multiplierAtTick(10, MAX));
    expect(result.events[0]?.type).toBe('player:cashed_out');
  });

  it('refuses a cash-out once the curve has passed the crash point', () => {
    const { state } = flying();
    const tooLate = makeCtx({
      players,
      serverSeed: seed,
      // Deliberately *before* the timer would have fired in a slow process: the
      // comparison is the authority, not the timer.
      now: T0 + state.crashAtMs,
    });

    expect(() => crash.reduce(tooLate, state, { type: 'cashout', userId: 'alice' })).toThrow(
      /already crashed/i,
    );
  });

  it('refuses a second cash-out, a stranger, and an unknown action', () => {
    const { state, ctx } = flying();
    const at = makeCtx({ players, serverSeed: seed, now: T0 + 5 * TICK_MS });
    const once = crash.reduce(at, state, { type: 'cashout', userId: 'alice' }).state;

    expect(() => crash.reduce(at, once, { type: 'cashout', userId: 'alice' })).toThrow(/already/i);
    expect(() => crash.reduce(at, state, { type: 'cashout', userId: 'mallory' })).toThrow(/not in/i);
    expect(() => crash.reduce(ctx, state, { type: 'bet', userId: 'alice' })).toThrow(/Unknown/i);
  });

  it('refuses a cash-out after the round has crashed', () => {
    const { state, ctx } = flying();
    const crashed = crash.onTimeout(ctx, state, CRASH_TIMER_ID).state;
    expect(() => crash.reduce(ctx, crashed, { type: 'cashout', userId: 'alice' })).toThrow(
      /already crashed/i,
    );
  });

  it('does not mutate the state it is handed', () => {
    const { state } = flying();
    const before = JSON.stringify(state);
    crash.reduce(makeCtx({ players, serverSeed: seed, now: T0 + 300 }), state, {
      type: 'cashout',
      userId: 'alice',
    });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('crash — auto cash-out', () => {
  const seed = seedCrashingAbove(500);
  const crashPoint = crashPointFromSeed(seed, EDGE_BPS, MAX);

  it('pays a target the curve reached, and only that', () => {
    const winner: GamePlayer = { ...alice, meta: { autoCashOutX100: 200 } };
    // A target above the crash point is a ride that lost, however early it was set.
    const loser: GamePlayer = { ...bob, meta: { autoCashOutX100: crashPoint + 1_000 } };
    const players = [winner, loser];

    const ctx = makeCtx({ players, serverSeed: seed });
    const crashed = crash.onTimeout(ctx, crash.init(ctx), CRASH_TIMER_ID).state;

    expect(crashed.phase).toBe('crashed');
    expect(crashed.cashOuts.alice).toBe(multiplierAtTick(ticksToReach(200, MAX), MAX));
    expect(crashed.cashOuts.bob).toBeUndefined();
  });

  it('never overrides a cash-out the player already made', () => {
    const players: GamePlayer[] = [{ ...alice, meta: { autoCashOutX100: 500 } }];
    const ctx = makeCtx({ players, serverSeed: seed });
    const state = crash.init(ctx);

    const manual = crash.reduce(makeCtx({ players, serverSeed: seed, now: T0 + 2 * TICK_MS }), state, {
      type: 'cashout',
      userId: 'alice',
    }).state;

    const crashed = crash.onTimeout(ctx, manual, CRASH_TIMER_ID).state;
    expect(crashed.cashOuts.alice).toBe(multiplierAtTick(2, MAX));
  });

  it('ignores a nonsense target rather than guessing what was meant', () => {
    for (const target of [100, 0, -50, 1.5, 'high']) {
      const players: GamePlayer[] = [{ ...alice, meta: { autoCashOutX100: target } }];
      const ctx = makeCtx({ players, serverSeed: seed });
      const crashed = crash.onTimeout(ctx, crash.init(ctx), CRASH_TIMER_ID).state;
      expect(crashed.cashOuts.alice).toBeUndefined();
    }
  });

  it('is what makes a disconnected player safe — no action needed, ever', () => {
    const players: GamePlayer[] = [{ ...alice, meta: { autoCashOutX100: 150 } }];
    const ctx = makeCtx({ players, serverSeed: seed });

    // No `reduce` call at all: the player never came back.
    const crashed = crash.onTimeout(ctx, crash.init(ctx), CRASH_TIMER_ID).state;
    const payouts = crash.settle(ctx, crashed);

    expect(payouts[0]!.amount).toBeGreaterThan(alice.stake);
  });
});

describe('crash — settlement', () => {
  const seed = seedCrashingAbove(500);

  it('pays stake × multiplier to cash-outs and nothing to rides', () => {
    const players = [alice, bob];
    const ctx = makeCtx({ players, serverSeed: seed });
    const state = crash.init(ctx);

    const cashed = crash.reduce(makeCtx({ players, serverSeed: seed, now: T0 + 20 * TICK_MS }), state, {
      type: 'cashout',
      userId: 'alice',
    }).state;
    const crashed = crash.onTimeout(ctx, cashed, CRASH_TIMER_ID).state;

    const payouts = crash.settle(ctx, crashed);
    const multiplier = multiplierAtTick(20, MAX);

    expect(payouts).toEqual([
      { userId: 'alice', amount: Math.floor((alice.stake * multiplier) / 100) },
      { userId: 'bob', amount: 0 },
    ]);
  });

  it('can pay more than the pot — that is what house-banked means', () => {
    const highSeed = seedCrashingAbove(2_000);
    const players = [alice];
    const ctx = makeCtx({ players, serverSeed: highSeed });
    const state = crash.init(ctx);

    const ticks = ticksToReach(1_000, MAX);
    const cashed = crash.reduce(
      makeCtx({ players, serverSeed: highSeed, now: T0 + ticks * TICK_MS }),
      state,
      { type: 'cashout', userId: 'alice' },
    ).state;
    const crashed = crash.onTimeout(ctx, cashed, CRASH_TIMER_ID).state;

    const total = crash.settle(ctx, crashed).reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBeGreaterThan(alice.stake);
    expect(crash.meta.banking).toBe('house');
    // And still bounded by what the game declares it can owe.
    expect(total).toBeLessThanOrEqual((alice.stake * crash.meta.maxPayoutX100!) / 100);
  });

  it('settles an instant bust as a total house win', () => {
    // A seed whose crash point clamps to 1.00x: nobody can cash out at all.
    let bustSeed = '';
    for (let i = 0; i < 100_000 && !bustSeed; i++) {
      if (crashPointFromSeed(`bust-${i}`, EDGE_BPS, MAX) === BASE_X100) bustSeed = `bust-${i}`;
    }
    expect(bustSeed).not.toBe('');

    const players = [alice, bob];
    const ctx = makeCtx({ players, serverSeed: bustSeed });
    const state = crash.init(ctx);

    expect(state.crashAtMs).toBe(0);
    expect(() => crash.reduce(ctx, state, { type: 'cashout', userId: 'alice' })).toThrow();

    const crashed = crash.onTimeout(ctx, state, CRASH_TIMER_ID).state;
    expect(crash.settle(ctx, crashed).every((p) => p.amount === 0)).toBe(true);
  });

  it('settles a free-play round without inventing a payout', () => {
    const free: GamePlayer[] = [{ userId: 'alice', seat: 0, stake: 0 }];
    const highSeed = seedCrashingAbove(1_000);
    const ctx = makeCtx({ players: free, serverSeed: highSeed });
    const state = crash.init(ctx);

    const cashed = crash.reduce(
      makeCtx({ players: free, serverSeed: highSeed, now: T0 + 30 * TICK_MS }),
      state,
      { type: 'cashout', userId: 'alice' },
    ).state;
    const crashed = crash.onTimeout(ctx, cashed, CRASH_TIMER_ID).state;

    expect(crash.settle(ctx, crashed)).toEqual([{ userId: 'alice', amount: 0 }]);
  });
});

describe('crash — information hiding', () => {
  const seed = seedCrashingAbove(1_000);
  const players = [alice, bob];

  it('never shows the crash point or the seed while the round is flying', () => {
    const ctx = makeCtx({ players, serverSeed: seed });
    const state = crash.init(ctx);

    for (const view of [
      crash.playerView(ctx, state, 'alice'),
      crash.playerView(ctx, state, 'bob'),
      crash.publicView!(ctx, state),
    ]) {
      expect(view.crashedAtX100).toBeNull();
      expect(view.serverSeed).toBeNull();
      expect(JSON.stringify(view)).not.toContain(seed);
      // The live multiplier is the only number derived from the crash point that leaves
      // the reducer, and while flying it must sit strictly below it — a view showing the
      // crash point *is* the leak.
      expect(view.multiplierX100 as number).toBeLessThan(state.crashPointX100);
      expect(Object.keys(view)).not.toContain('crashPointX100');
    }
  });

  it('clamps the live multiplier to the crash point rather than showing an impossible one', () => {
    const state = crash.init(makeCtx({ players, serverSeed: seed }));
    const wayPast = makeCtx({ players, serverSeed: seed, now: T0 + 10 * 60 * 1_000 });

    expect(crash.publicView!(wayPast, state).multiplierX100).toBe(state.crashPointX100);
  });

  it('reveals the seed and the crash point once the round is over — that is the proof', () => {
    const ctx = makeCtx({ players, serverSeed: seed });
    const crashed = crash.onTimeout(ctx, crash.init(ctx), CRASH_TIMER_ID).state;
    const view = crash.publicView!(ctx, crashed);

    expect(view.serverSeed).toBe(seed);
    expect(view.crashedAtX100).toBe(crashed.crashPointX100);
    expect(commitmentFor(view.serverSeed as string)).toBe(view.commitment);
  });

  it("shows a player their own bet and only aggregate facts about everyone else's", () => {
    const withAuto: GamePlayer[] = [{ ...alice, meta: { autoCashOutX100: 300 } }, bob];
    const ctx = makeCtx({ players: withAuto, serverSeed: seed });
    const state = crash.init(ctx);

    const aliceView = crash.playerView(ctx, state, 'alice');
    const bobView = crash.playerView(ctx, state, 'bob');

    expect(aliceView.yourBet).toMatchObject({ amount: alice.stake, autoCashOutX100: 300 });
    // Bob sees that alice bet, and how much — public in a social game — but not her plan.
    expect(bobView.yourBet).toMatchObject({ amount: bob.stake, autoCashOutX100: null });
    expect(JSON.stringify(bobView.bets)).not.toContain('autoCashOut');
  });

  it('gives a spectator no per-player private view at all', () => {
    const ctx = makeCtx({ players, serverSeed: seed });
    const view = crash.publicView!(ctx, crash.init(ctx));
    expect(view.yourBet).toBeUndefined();
  });
});
