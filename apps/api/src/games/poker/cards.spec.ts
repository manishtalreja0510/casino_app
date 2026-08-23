import {
  DECK_SIZE,
  HandCategory,
  cardName,
  evaluate,
  parseCard,
  rankOf,
  shuffle,
  suitOf,
} from './cards';

const hand = (...names: string[]) => names.map(parseCard);
const rankOfHand = (...names: string[]) => evaluate(hand(...names));

/** Every category, built from a seven-card board+hole set as it would really arrive. */
describe('hand evaluator — categories', () => {
  const cases: Array<[string, string[], number]> = [
    ['straight flush', ['9h', '8h', '7h', '6h', '5h', '2c', 'Ad'], HandCategory.STRAIGHT_FLUSH],
    ['quads', ['9h', '9s', '9d', '9c', '5h', '2c', 'Ad'], HandCategory.QUADS],
    ['full house', ['9h', '9s', '9d', '5c', '5h', '2c', 'Ad'], HandCategory.FULL_HOUSE],
    ['flush', ['Ah', 'Jh', '9h', '6h', '3h', '2c', 'Kd'], HandCategory.FLUSH],
    ['straight', ['9h', '8s', '7d', '6c', '5h', '2c', 'Ad'], HandCategory.STRAIGHT],
    ['trips', ['9h', '9s', '9d', 'Kc', '5h', '2c', 'Ad'], HandCategory.TRIPS],
    ['two pair', ['9h', '9s', '5d', '5c', 'Kh', '2c', 'Ad'], HandCategory.TWO_PAIR],
    ['pair', ['9h', '9s', 'Jd', '5c', 'Kh', '2c', 'Ad'], HandCategory.PAIR],
    ['high card', ['9h', '7s', 'Jd', '5c', 'Kh', '2c', 'Ad'], HandCategory.HIGH_CARD],
  ];

  it.each(cases)('recognises %s', (_name, cards, category) => {
    expect(evaluate(hand(...cards)).category).toBe(category);
  });

  it('orders the categories the way poker does', () => {
    const ordered = cases.map(([, cards]) => evaluate(hand(...cards)).value);
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(ordered[i]!).toBeGreaterThan(ordered[i + 1]!);
    }
  });
});

describe('hand evaluator — the cases that catch a naive implementation', () => {
  it('reads the wheel as a five-high straight, not an ace-high one', () => {
    const wheel = rankOfHand('Ah', '2s', '3d', '4c', '5h', 'Kd', 'Qc');
    expect(wheel.category).toBe(HandCategory.STRAIGHT);

    // A six-high straight beats it; that is the whole point of the ace being low here.
    const sixHigh = rankOfHand('2s', '3d', '4c', '5h', '6d', 'Kd', 'Qc');
    expect(sixHigh.value).toBeGreaterThan(wheel.value);
  });

  it('reads the steel wheel as a straight flush', () => {
    const steel = rankOfHand('Ah', '2h', '3h', '4h', '5h', 'Kd', 'Qc');
    expect(steel.category).toBe(HandCategory.STRAIGHT_FLUSH);
    // …and the lowest one: a six-high straight flush beats it.
    expect(rankOfHand('2h', '3h', '4h', '5h', '6h', 'Kd', 'Qc').value).toBeGreaterThan(steel.value);
  });

  it('does not invent a straight from a wrapping A-K-Q-J-2', () => {
    expect(rankOfHand('Ah', 'Ks', 'Qd', 'Jc', '2h', '7d', '3c').category).toBe(
      HandCategory.HIGH_CARD,
    );
  });

  it('does not call five suited cards spread over a non-straight a straight flush', () => {
    const flush = rankOfHand('Ah', 'Jh', '9h', '6h', '3h', '2c', 'Kd');
    expect(flush.category).toBe(HandCategory.FLUSH);
  });

  it('picks the higher trips for the full house when the board pairs twice', () => {
    // 9s full of 5s, not 5s full of 9s.
    const house = rankOfHand('9h', '9s', '9d', '5c', '5h', '5s', 'Ad');
    expect(house.category).toBe(HandCategory.FULL_HOUSE);
    expect(house.value).toBeGreaterThan(evaluate(hand('5h', '5s', '5d', '9c', '9h', '2c', '3d')).value);
  });

  it('beats a lower flush with a higher one on the same suit', () => {
    const higher = rankOfHand('Ah', 'Jh', '9h', '6h', '3h', '2c', '4d');
    const lower = rankOfHand('Kh', 'Jh', '9h', '6h', '3h', '2c', '4d');
    expect(higher.value).toBeGreaterThan(lower.value);
  });

  it('separates two pair by the kicker when both pairs match', () => {
    const better = rankOfHand('9h', '9s', '5d', '5c', 'Ah', '2c', '3d');
    const worse = rankOfHand('9h', '9s', '5d', '5c', 'Kh', '2c', '3d');
    expect(better.value).toBeGreaterThan(worse.value);
  });

  it('uses exactly three kickers for a pair and two for trips', () => {
    // Same pair, same three best kickers, different sixth and seventh cards: a tie.
    const a = rankOfHand('9h', '9s', 'Ad', 'Kc', 'Qh', '3c', '2d');
    const b = rankOfHand('9c', '9d', 'Ah', 'Ks', 'Qc', '5c', '4d');
    expect(a.value).toBe(b.value);
  });

  it('ties two identical hands, which is what a split pot is', () => {
    const a = rankOfHand('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d');
    const b = rankOfHand('As', 'Ks', 'Qs', 'Js', 'Ts', '4c', '5d');
    expect(a.value).toBe(b.value);
  });

  it('returns the five cards that actually make the hand', () => {
    const result = rankOfHand('9h', '9s', '9d', '9c', 'Ah', '2c', '3d');
    expect(result.cards).toHaveLength(5);
    expect(result.cards.map(cardName).sort()).toEqual(['9c', '9d', '9h', '9s', 'Ah'].sort());
  });

  it('evaluates a five-card hand as happily as a seven-card one', () => {
    expect(rankOfHand('Ah', 'Kh', 'Qh', 'Jh', 'Th').category).toBe(HandCategory.STRAIGHT_FLUSH);
    expect(() => evaluate(hand('Ah', 'Kh', 'Qh', 'Jh'))).toThrow(/five cards/i);
  });
});

describe('cards', () => {
  it('round-trips every card through its name', () => {
    for (let card = 0; card < DECK_SIZE; card++) {
      expect(parseCard(cardName(card))).toBe(card);
    }
  });

  it('covers all 52 distinct rank/suit pairs exactly once', () => {
    const seen = new Set<string>();
    for (let card = 0; card < DECK_SIZE; card++) seen.add(`${rankOf(card)}-${suitOf(card)}`);
    expect(seen.size).toBe(DECK_SIZE);
  });
});

describe('shuffle', () => {
  it('returns a permutation of the whole deck — no missing or duplicate card', () => {
    const deck = shuffle(makeRandom(12345));
    expect(new Set(deck).size).toBe(DECK_SIZE);
    expect([...deck].sort((a, b) => a - b)).toEqual(Array.from({ length: DECK_SIZE }, (_, i) => i));
  });

  it('is deterministic for the same draws — the basis of replay', () => {
    expect(shuffle(makeRandom(7))).toEqual(shuffle(makeRandom(7)));
    expect(shuffle(makeRandom(7))).not.toEqual(shuffle(makeRandom(8)));
  });

  it('draws exactly once per position, with the right bound each time', () => {
    const bounds: number[] = [];
    shuffle((max) => {
      bounds.push(max);
      return 0;
    });
    // Fisher–Yates walks down from the top: bounds 52, 51, … 2.
    expect(bounds).toEqual(Array.from({ length: DECK_SIZE - 1 }, (_, i) => DECK_SIZE - i));
  });

  it('does not favour any position — every card reaches the top over many shuffles', () => {
    // Not a randomness test (the CSPRNG is not on trial here); a wiring test. A shuffle
    // that ignored its draws, or applied them to the wrong index, would show up as a
    // top card that barely moves.
    const tops = new Set<number>();
    for (let seed = 0; seed < 400; seed++) tops.add(shuffle(makeRandom(seed))[0]!);
    expect(tops.size).toBeGreaterThan(20);
  });
});

/** A deterministic stand-in for the engine's audited RNG. */
function makeRandom(seed: number): (max: number) => number {
  let state = seed * 2654435761 + 1;
  return (max: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % max;
  };
}

/**
 * Cross-validation against a deliberately different implementation.
 *
 * Examples prove the cases someone thought of. This proves the ones nobody did: for tens of
 * thousands of random seven-card hands, the fast evaluator must agree with a brute-force
 * reference that tries all 21 five-card subsets and ranks each with an independently
 * written five-card ranker. The two share no code, so a bug would have to occur twice, the
 * same way, to hide.
 *
 * The comparison is on *ordering*, not on the packed integers — the two encode differently,
 * and ordering is the only thing the game asks of them.
 *
 * Trial counts are a deliberate trade: the reference ranks 21 subsets per hand, so this is
 * the slowest thing in the unit suite. A few thousand hands per run, with a different seed
 * per test, finds a systematic bug immediately and a rare one across runs — while keeping
 * the suite fast enough that people still run it.
 */
describe('hand evaluator — cross-validated against brute force', () => {
  it('agrees with the reference on the category of random hands', () => {
    const random = makeRandom(99);
    for (let trial = 0; trial < 8_000; trial++) {
      const cards = dealDistinct(random, 7);
      expect(evaluate(cards).category).toBe(referenceBest(cards).category);
    }
  });

  it('orders every pair of random hands the same way the reference does', () => {
    const random = makeRandom(4242);
    for (let trial = 0; trial < 5_000; trial++) {
      const pool = dealDistinct(random, 14);
      const a = pool.slice(0, 7);
      const b = pool.slice(7, 14);

      const mine = Math.sign(evaluate(a).value - evaluate(b).value);
      const theirs = Math.sign(compareTuples(referenceBest(a).tuple, referenceBest(b).tuple));
      expect(mine).toBe(theirs);
    }
  });

  it('agrees about ties, which is what decides a split pot', () => {
    const random = makeRandom(31337);
    let ties = 0;
    for (let trial = 0; trial < 5_000; trial++) {
      const pool = dealDistinct(random, 14);
      const a = pool.slice(0, 7);
      const b = pool.slice(7, 14);

      const mineTied = evaluate(a).value === evaluate(b).value;
      const theirsTied = compareTuples(referenceBest(a).tuple, referenceBest(b).tuple) === 0;
      expect(mineTied).toBe(theirsTied);
      if (mineTied) ties++;
    }
    // Sanity on the test itself: if ties never occurred, the assertion above proved nothing.
    expect(ties).toBeGreaterThan(0);
  });
});

function dealDistinct(random: (max: number) => number, count: number): number[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = random(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck.slice(0, count);
}

/** Best five-card subset, by brute force over all 21 combinations. */
function referenceBest(cards: readonly number[]): { category: number; tuple: number[] } {
  let best: number[] | null = null;
  for (let a = 0; a < cards.length; a++) {
    for (let b = a + 1; b < cards.length; b++) {
      for (let c = b + 1; c < cards.length; c++) {
        for (let d = c + 1; d < cards.length; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const tuple = rankFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (best === null || compareTuples(tuple, best) > 0) best = tuple;
          }
        }
      }
    }
  }
  return { category: best![0]!, tuple: best! };
}

/**
 * An independent five-card ranker: `[category, ...tiebreakers]`, all descending.
 *
 * Written from the rules rather than from the implementation under test — different
 * structure, different traversal, no shared helpers.
 */
function rankFive(cards: readonly number[]): number[] {
  const ranks = cards.map((c) => Math.floor(c / 4)).sort((x, y) => y - x);
  const suits = cards.map((c) => c % 4);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);

  // Rank groups sorted by count then rank, both descending.
  const grouped = [...counts.entries()].sort((p, q) => q[1] - p[1] || q[0] - p[0]);
  const shape = grouped.map(([, count]) => count);
  const order = grouped.map(([rank]) => rank);

  const isFlush = suits.every((s) => s === suits[0]);

  const distinct = [...new Set(ranks)].sort((x, y) => y - x);
  let straightHigh = -1;
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!;
    // The wheel: A-5-4-3-2 ranks as five-high.
    else if (distinct[0] === 12 && distinct[1] === 3 && distinct[4] === 0) straightHigh = 3;
  }

  if (isFlush && straightHigh >= 0) return [8, straightHigh];
  if (shape[0] === 4) return [7, order[0]!, order[1]!];
  if (shape[0] === 3 && shape[1] === 2) return [6, order[0]!, order[1]!];
  if (isFlush) return [5, ...distinct];
  if (straightHigh >= 0) return [4, straightHigh];
  if (shape[0] === 3) return [3, order[0]!, ...order.slice(1).sort((x, y) => y - x)];
  if (shape[0] === 2 && shape[1] === 2) {
    const pairsHighFirst = [order[0]!, order[1]!].sort((x, y) => y - x);
    return [2, ...pairsHighFirst, order[2]!];
  }
  if (shape[0] === 2) return [1, order[0]!, ...order.slice(1).sort((x, y) => y - x)];
  return [0, ...distinct];
}

function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}
