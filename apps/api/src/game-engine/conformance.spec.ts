import { runConformance } from './conformance';
import { coinDuel, type CoinDuelState } from './games/coin-duel.game';
import { CRASH_TIMER_ID, crash, type CrashState } from '../games/crash/crash.game';
import { commitmentFor, crashPointFromSeed, TICK_MS } from '../games/crash/crash.math';

/**
 * The reference game must pass the suite every shipped game will have to pass.
 * If this ever fails, the contract's guarantees are not guarantees.
 */
describe('game conformance suite', () => {
  const players = [
    { userId: 'player-a', seat: 0, stake: 1000 },
    { userId: 'player-b', seat: 1, stake: 1000 },
  ];

  it('coin-duel conforms', () => {
    const findings = runConformance<CoinDuelState>(coinDuel, {
      players,
      script: [
        { type: 'pick', userId: 'player-a', payload: { choice: 'heads' } },
        { type: 'pick', userId: 'player-b', payload: { choice: 'tails' } },
      ],
      secretViewKeys: ['picks'],
    });

    expect(findings).toEqual([]);
  });

  it('crash conforms — the same suite, a very different game', () => {
    // Crash is round-based and house-banked, so it exercises the parts of the suite
    // coin-duel cannot: a clock-driven outcome, a terminal state reached by a deadline
    // rather than a move, and payouts that legitimately exceed the pot.
    const seed = seedCrashingAbove(2_000);
    const t0 = 1_700_000_000_000;

    const findings = runConformance<CrashState>(crash, {
      players,
      config: {
        betMin: 100,
        betMax: 100_000,
        maxRoundStake: 1_000_000,
        maxHouseExposure: 100_000_000,
        bettingWindowMs: 7_000,
        interRoundMs: 5_000,
        houseEdgeBps: 300,
        maxMultiplierX100: 10_000,
        serverSeed: seed,
        commitment: commitmentFor(seed),
      },
      // init reads the clock once; the cash-out is priced 20 ticks later.
      clock: [t0, t0 + 20 * TICK_MS],
      script: [{ type: 'cashout', userId: 'player-a' }],
      finalTimerId: CRASH_TIMER_ID,
    });

    expect(findings).toEqual([]);
  });

  it('catches a house-banked game that will not say what it can owe', () => {
    // Unbounded house liability is the failure mode a pooled game cannot have and a
    // house-banked one can. A game that declines to declare its ceiling fails the suite
    // rather than discovering the ceiling in production.
    const unbounded = {
      ...crash,
      meta: { ...crash.meta, maxPayoutX100: undefined },
    } as typeof crash;

    const seed = seedCrashingAbove(2_000);
    const t0 = 1_700_000_000_000;

    const findings = runConformance<CrashState>(unbounded, {
      players,
      config: {
        betMin: 100,
        betMax: 100_000,
        maxRoundStake: 1_000_000,
        maxHouseExposure: 100_000_000,
        bettingWindowMs: 7_000,
        interRoundMs: 5_000,
        houseEdgeBps: 300,
        maxMultiplierX100: 10_000,
        serverSeed: seed,
        commitment: commitmentFor(seed),
      },
      clock: [t0, t0 + 20 * TICK_MS],
      script: [{ type: 'cashout', userId: 'player-a' }],
      finalTimerId: CRASH_TIMER_ID,
    });

    expect(findings.some((finding) => finding.check === 'settlement')).toBe(true);
  });

  it('catches a game that leaks another player’s secret', () => {
    // A deliberately broken variant: its view returns the whole picks map. This proves
    // the suite would actually catch the poker equivalent — hole cards in someone else's
    // view — rather than passing everything put in front of it.
    const leaky = {
      ...coinDuel,
      playerView: (_ctx: unknown, state: CoinDuelState) => ({ picks: state.picks }),
    } as typeof coinDuel;

    const findings = runConformance<CoinDuelState>(leaky, {
      players,
      script: [{ type: 'pick', userId: 'player-a', payload: { choice: 'heads' } }],
      secretViewKeys: ['picks'],
    });

    expect(findings.some((finding) => finding.check === 'information-hiding')).toBe(true);
  });

  it('catches a game whose settlement pays out more than the pot', () => {
    const greedy = {
      ...coinDuel,
      settle: () => [{ userId: 'player-a', amount: 999_999 }],
    } as typeof coinDuel;

    const findings = runConformance<CoinDuelState>(greedy, {
      players,
      script: [
        { type: 'pick', userId: 'player-a', payload: { choice: 'heads' } },
        { type: 'pick', userId: 'player-b', payload: { choice: 'heads' } },
      ],
      secretViewKeys: ['picks'],
    });

    expect(findings.some((finding) => finding.check === 'settlement')).toBe(true);
  });

  it('catches a non-deterministic reducer', () => {
    // A counter, not Date.now(): two runs inside the same millisecond would produce the
    // same value and make this test flaky — the exact weakness it exists to detect.
    let hidden = 0;
    const flaky = {
      ...coinDuel,
      reduce: (_ctx: Parameters<typeof coinDuel.reduce>[0], state: CoinDuelState) => ({
        // State that depends on anything outside (ctx, state, action) breaks replay:
        // recovery would rebuild a different match than the one that was played.
        state: { ...state, pot: ++hidden },
        events: [],
      }),
    } as unknown as typeof coinDuel;

    const findings = runConformance<CoinDuelState>(flaky, {
      players,
      script: [{ type: 'pick', userId: 'player-a', payload: { choice: 'heads' } }],
      secretViewKeys: [],
    });

    expect(findings.some((f) => f.check === 'determinism' || f.check === 'purity')).toBe(true);
  });
});

/** A seed whose crash point is high enough for a scripted cash-out to land. */
function seedCrashingAbove(minX100: number): string {
  for (let i = 0; i < 100_000; i++) {
    const seed = `conformance-${i}`;
    if (crashPointFromSeed(seed, 300, 10_000) >= minX100) return seed;
  }
  throw new Error('no suitable seed');
}
