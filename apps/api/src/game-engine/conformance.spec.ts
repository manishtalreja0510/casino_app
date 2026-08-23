import { runConformance } from './conformance';
import { coinDuel, type CoinDuelState } from './games/coin-duel.game';

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
