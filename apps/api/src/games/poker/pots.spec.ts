import { parseCard } from './cards';
import { buildPots, returnUncalled, settleShowdown, type PotPlayer } from './pots';

const cards = (...names: string[]) => names.map(parseCard);

function player(
  userId: string,
  committed: number,
  options: Partial<Omit<PotPlayer, 'userId' | 'committed'>> = {},
): PotPlayer {
  return {
    userId,
    committed,
    folded: options.folded ?? false,
    allIn: options.allIn ?? false,
    order: options.order ?? 0,
    ...(options.cards ? { cards: options.cards } : {}),
  };
}

describe('uncalled excess', () => {
  it('returns the part of a bet nobody could match, before pots exist', () => {
    // A bets 500 into a table where the most anyone else has in is 200.
    const { players, returned } = returnUncalled([
      player('a', 500, { order: 0 }),
      player('b', 200, { order: 1, allIn: true }),
    ]);

    expect(returned).toEqual([{ userId: 'a', amount: 300 }]);
    expect(players.find((p) => p.userId === 'a')!.committed).toBe(200);
  });

  it('returns nothing when the top two commitments match', () => {
    const { returned } = returnUncalled([player('a', 200), player('b', 200)]);
    expect(returned).toEqual([]);
  });

  it('counts a folded player’s chips as matchable — they are in the pot', () => {
    // B folded having put in 200; A's 500 is still only called to 200.
    const { returned } = returnUncalled([
      player('a', 500),
      player('b', 200, { folded: true }),
    ]);
    expect(returned).toEqual([{ userId: 'a', amount: 300 }]);
  });
});

describe('pot construction', () => {
  it('makes one pot when everyone is in for the same amount', () => {
    const pots = buildPots([player('a', 100), player('b', 100), player('c', 100)]);
    expect(pots).toEqual([{ amount: 300, eligible: ['a', 'b', 'c'] }]);
  });

  it('cuts a side pot at each all-in level', () => {
    // Short is all-in for 50, mid all-in for 150, big has 300 in.
    const pots = buildPots([
      player('short', 50, { allIn: true, order: 0 }),
      player('mid', 150, { allIn: true, order: 1 }),
      player('big', 300, { order: 2 }),
    ]);

    expect(pots).toEqual([
      { amount: 150, eligible: ['short', 'mid', 'big'] }, // 50 x 3
      { amount: 200, eligible: ['mid', 'big'] }, //           100 x 2
      { amount: 150, eligible: ['big'] }, //                  150 x 1
    ]);
  });

  it('includes a folded player’s chips in the layers but never in eligibility', () => {
    const pots = buildPots([
      player('a', 100, { order: 0 }),
      player('b', 100, { order: 1 }),
      player('folder', 40, { folded: true, order: 2 }),
    ]);

    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(240);
    expect(pots[0]!.eligible).toEqual(['a', 'b']);
  });

  it('conserves every chip across the layers', () => {
    const players = [
      player('a', 50, { allIn: true, order: 0 }),
      player('b', 175, { allIn: true, order: 1 }),
      player('c', 400, { order: 2 }),
      player('d', 30, { folded: true, order: 3 }),
    ];
    const { players: adjusted } = returnUncalled(players);
    const total = adjusted.reduce((sum, p) => sum + p.committed, 0);
    expect(buildPots(adjusted).reduce((sum, pot) => sum + pot.amount, 0)).toBe(total);
  });
});

describe('showdown', () => {
  const board = cards('2h', '7d', '9c', 'Jh', 'Ks');

  it('awards the pot to the best hand', () => {
    const result = settleShowdown({
      players: [
        player('winner', 100, { order: 0, cards: cards('Kh', 'Kd') }), // trip kings
        player('loser', 100, { order: 1, cards: cards('Ah', 'Qd') }), // ace high
      ],
      board,
      rake: 0,
    });

    expect(result.awards).toEqual([{ userId: 'winner', amount: 200 }]);
  });

  it('splits a tied pot evenly', () => {
    const result = settleShowdown({
      players: [
        player('a', 100, { order: 0, cards: cards('Ah', 'Qd') }),
        player('b', 100, { order: 1, cards: cards('As', 'Qc') }),
      ],
      board,
      rake: 0,
    });

    expect(result.awards).toEqual([
      { userId: 'a', amount: 100 },
      { userId: 'b', amount: 100 },
    ]);
  });

  it('gives the odd chip to the winner closest to the button’s left', () => {
    const result = settleShowdown({
      players: [
        player('later', 51, { order: 3, cards: cards('Ah', 'Qd') }),
        player('earlier', 50, { order: 1, cards: cards('As', 'Qc') }),
      ],
      board,
      rake: 0,
    });

    // 101 total, minus the 1 uncalled = 100 pot… so make it genuinely odd instead.
    const odd = settleShowdown({
      players: [
        player('later', 50, { order: 3, cards: cards('Ah', 'Qd') }),
        player('earlier', 50, { order: 1, cards: cards('As', 'Qc') }),
        player('folder', 1, { folded: true, order: 2 }),
      ],
      board,
      rake: 0,
    });

    expect(result.returned).toEqual([{ userId: 'later', amount: 1 }]);

    const earlier = odd.awards.find((a) => a.userId === 'earlier')!;
    const later = odd.awards.find((a) => a.userId === 'later')!;
    expect(earlier.amount).toBe(51);
    expect(later.amount).toBe(50);
  });

  it('lets a short stack win the main pot while the side pot goes elsewhere', () => {
    const result = settleShowdown({
      players: [
        // Short is all-in for 50 with the best hand: trip kings.
        player('short', 50, { allIn: true, order: 0, cards: cards('Kh', 'Kd') }),
        // Big has more chips and a worse hand: two pair.
        player('big', 200, { order: 1, cards: cards('9h', 'Jd') }),
        // Mid has the second-best hand and covers the side pot.
        player('mid', 200, { order: 2, cards: cards('Jc', 'Js') }),
      ],
      board,
      rake: 0,
    });

    const short = result.awards.find((a) => a.userId === 'short')!;
    const mid = result.awards.find((a) => a.userId === 'mid')!;

    expect(short.amount).toBe(150); // main pot: 50 x 3
    expect(mid.amount).toBe(300); // side pot: 150 x 2, trip jacks beats two pair
    expect(result.awards.find((a) => a.userId === 'big')).toBeUndefined();
  });

  it('gives the pot to the last player standing when everyone else folded', () => {
    const result = settleShowdown({
      players: [
        player('winner', 100, { order: 0, cards: cards('2c', '3d') }),
        player('folder', 60, { folded: true, order: 1, cards: cards('Ah', 'Ad') }),
      ],
      board,
      rake: 0,
    });

    // 100 vs 60: the 40 nobody matched comes back first.
    expect(result.returned).toEqual([{ userId: 'winner', amount: 40 }]);
    expect(result.awards).toEqual([{ userId: 'winner', amount: 120 }]);
  });

  it('takes rake from the pot, never from a player’s stack', () => {
    const result = settleShowdown({
      players: [
        player('winner', 100, { order: 0, cards: cards('Kh', 'Kd') }),
        player('loser', 100, { order: 1, cards: cards('Ah', 'Qd') }),
      ],
      board,
      rake: 10,
    });

    expect(result.rake).toBe(10);
    expect(result.awards).toEqual([{ userId: 'winner', amount: 190 }]);
  });

  it('spreads rake across side pots and takes exactly the amount asked for', () => {
    const result = settleShowdown({
      players: [
        player('short', 50, { allIn: true, order: 0, cards: cards('Kh', 'Kd') }),
        player('big', 200, { order: 1, cards: cards('9h', 'Jd') }),
        player('mid', 200, { order: 2, cards: cards('Jc', 'Js') }),
      ],
      board,
      rake: 7,
    });

    const awarded = result.awards.reduce((sum, a) => sum + a.amount, 0);
    const potTotal = result.pots.reduce((sum, p) => sum + p.amount, 0);
    expect(result.rake).toBe(7);
    expect(awarded + result.rake).toBe(potTotal);
  });

  it('never rakes more than the pot holds', () => {
    const result = settleShowdown({
      players: [
        player('a', 10, { order: 0, cards: cards('Kh', 'Kd') }),
        player('b', 10, { order: 1, cards: cards('Ah', 'Qd') }),
      ],
      board,
      rake: 999,
    });
    expect(result.rake).toBe(20);
    expect(result.awards.reduce((sum, a) => sum + a.amount, 0)).toBe(0);
  });
});

describe('chip conservation (the property the whole file exists for)', () => {
  it('awards, returns or rakes every committed chip — over random tables', () => {
    const random = makeRandom(2024);
    const holes = [
      cards('Ah', 'Kh'),
      cards('Qs', 'Qd'),
      cards('7c', '2d'),
      cards('Jh', 'Ts'),
      cards('4c', '4d'),
      cards('9s', '8s'),
    ];
    const board = cards('2h', '7d', '9c', 'Jd', 'Ks');

    for (let trial = 0; trial < 3_000; trial++) {
      const count = 2 + random(5);
      const draft: Array<{ committed: number; folded: boolean; allIn: boolean }> = [];

      for (let i = 0; i < count; i++) {
        draft.push({ committed: random(500), folded: random(4) === 0, allIn: random(3) === 0 });
      }

      // Keep the generated tables *reachable*.
      //
      // At least one player must be live — a hand with nobody in it does not exist — and a
      // folded player can never have out-committed everyone still live, because you fold
      // facing a bet, so somebody live always matched or exceeded you. Generating
      // unreachable states was making this property fail against a correct implementation,
      // which is a test bug rather than a finding; the real defence against those states is
      // the conservation assertion inside `settleShowdown`.
      draft[0]!.folded = false;
      const maxLive = Math.max(...draft.filter((d) => !d.folded).map((d) => d.committed));
      const players: PotPlayer[] = draft.map((d, i) =>
        player(`p${i}`, d.folded ? Math.min(d.committed, maxLive) : d.committed, {
          order: i,
          folded: d.folded,
          allIn: d.allIn,
          cards: holes[i]!,
        }),
      );

      const committedTotal = players.reduce((sum, p) => sum + p.committed, 0);
      const rakeAsked = random(20);
      const result = settleShowdown({ players, board, rake: rakeAsked });

      const awarded = result.awards.reduce((sum, a) => sum + a.amount, 0);
      const returned = result.returned.reduce((sum, a) => sum + a.amount, 0);

      expect(awarded + returned + result.rake).toBe(committedTotal);
      expect(result.awards.every((a) => a.amount >= 0)).toBe(true);
      expect(Number.isSafeInteger(awarded)).toBe(true);
    }
  });
});

describe('the conservation assertion itself', () => {
  it('throws rather than quietly losing chips in a state the game cannot reach', () => {
    // Two folded players holding more than anyone live is unreachable in real play — you
    // fold facing a bet, so somebody live always matched you. If it ever happened, the
    // chips above the top live commitment would belong to no pot and no player: returning
    // the uncalled excess covers the top committer, and the second one's surplus has
    // nowhere to go. Stopping is the only defensible answer — the hand stays unsettled and
    // a human looks at it, rather than chips evaporating into a rounding-shaped hole.
    expect(() =>
      settleShowdown({
        players: [
          player('live', 100, { order: 0, cards: cards('Ah', 'Kh') }),
          player('impossible-a', 400, { folded: true, order: 1 }),
          player('impossible-b', 300, { folded: true, order: 2 }),
        ],
        board: cards('2h', '7d', '9c', 'Jh', 'Ks'),
        rake: 0,
      }),
    ).toThrow(/lost chips/i);
  });
});

function makeRandom(seed: number): (max: number) => number {
  let state = seed * 2654435761 + 1;
  return (max: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return max <= 0 ? 0 : state % max;
  };
}
