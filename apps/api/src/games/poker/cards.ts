/**
 * Cards, and the 7-card hand evaluator.
 *
 * A card is an integer 0–51: `rank * 4 + suit`, rank 0 = deuce … 12 = ace. Integers rather
 * than strings because a deck is shuffled from recorded RNG draws and compared on replay —
 * and because the evaluator runs on every showdown for every table.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export const DECK_SIZE = 52;

export type Card = number;

export function rankOf(card: Card): number {
  return Math.floor(card / 4);
}

export function suitOf(card: Card): number {
  return card % 4;
}

/** `As`, `Td`, `2c` — for logs, views and tests. Never parsed back into game logic. */
export function cardName(card: Card): string {
  return `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;
}

export function cardNames(cards: readonly Card[]): string[] {
  return cards.map(cardName);
}

/** Parses `As` / `Td`. Test and fixture use only. */
export function parseCard(name: string): Card {
  const rank = RANKS.indexOf(name[0] as (typeof RANKS)[number]);
  const suit = SUITS.indexOf(name[1] as (typeof SUITS)[number]);
  if (rank < 0 || suit < 0) throw new Error(`not a card: ${name}`);
  return rank * 4 + suit;
}

/**
 * Fisher–Yates, drawing from the game context's audited RNG.
 *
 * The draws are recorded with the event that produced them, so replaying a hand deals the
 * same cards in the same order — which is what makes a disputed hand answerable and crash
 * recovery possible at all (engine §9). Every index is a separate audited draw.
 */
export function shuffle(random: (max: number, purpose: string) => number): Card[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = random(i + 1, `shuffle:${i}`);
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }
  return deck;
}

/** Hand categories, ordered so a larger number always beats a smaller one. */
export const HandCategory = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

export const CATEGORY_NAMES: Record<number, string> = {
  0: 'high card',
  1: 'a pair',
  2: 'two pair',
  3: 'three of a kind',
  4: 'a straight',
  5: 'a flush',
  6: 'a full house',
  7: 'four of a kind',
  8: 'a straight flush',
};

export interface HandRank {
  /** Single comparable integer. Higher wins; equal is a genuine tie (a split pot). */
  readonly value: number;
  readonly category: number;
  /** The five cards that make the hand, best first — for the showdown display. */
  readonly cards: readonly Card[];
}

/**
 * Ranks the best five-card hand out of five to seven cards.
 *
 * The result is one integer so that comparison is unambiguous and total: `category` in the
 * high digits, then five kickers in descending significance, base 16. Two hands tie if and
 * only if their values are equal — which is exactly the condition for splitting a pot, so
 * the split rule needs no separate notion of equality.
 */
export function evaluate(cards: readonly Card[]): HandRank {
  if (cards.length < 5) throw new Error('a hand needs at least five cards');

  const byRank: number[] = Array(13).fill(0);
  const bySuit: number[] = Array(4).fill(0);
  const suited: Card[][] = [[], [], [], []];

  for (const card of cards) {
    byRank[rankOf(card)]!++;
    bySuit[suitOf(card)]!++;
    suited[suitOf(card)]!.push(card);
  }

  const flushSuit = bySuit.findIndex((count) => count >= 5);

  // Straight flush first: it is the only category where the flush cards' *order* matters,
  // and finding it early avoids ranking the same cards twice.
  if (flushSuit >= 0) {
    const flushCards = suited[flushSuit]!;
    const straightFlush = findStraight(flushCards);
    if (straightFlush) {
      return rank(HandCategory.STRAIGHT_FLUSH, [rankOf(straightFlush[0]!)], straightFlush);
    }
  }

  const groups = groupsByCount(byRank);
  const quad = groups.find((g) => g.count === 4);
  const trips = groups.filter((g) => g.count === 3);
  const pairs = groups.filter((g) => g.count === 2);

  if (quad) {
    const kicker = highestExcluding(cards, [quad.rank], 1);
    return rank(
      HandCategory.QUADS,
      [quad.rank, rankOf(kicker[0]!)],
      [...pick(cards, quad.rank, 4), ...kicker],
    );
  }

  // Two sets of trips is a full house using the higher set as the trips.
  const bestTrips = trips[0];
  const pairForHouse = trips[1] ?? pairs[0];
  if (bestTrips && pairForHouse) {
    return rank(
      HandCategory.FULL_HOUSE,
      [bestTrips.rank, pairForHouse.rank],
      [...pick(cards, bestTrips.rank, 3), ...pick(cards, pairForHouse.rank, 2)],
    );
  }

  if (flushSuit >= 0) {
    const best = [...suited[flushSuit]!].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
    return rank(HandCategory.FLUSH, best.map(rankOf), best);
  }

  const straight = findStraight(cards);
  if (straight) return rank(HandCategory.STRAIGHT, [rankOf(straight[0]!)], straight);

  if (bestTrips) {
    const kickers = highestExcluding(cards, [bestTrips.rank], 2);
    return rank(
      HandCategory.TRIPS,
      [bestTrips.rank, ...kickers.map(rankOf)],
      [...pick(cards, bestTrips.rank, 3), ...kickers],
    );
  }

  if (pairs.length >= 2) {
    const [high, low] = [pairs[0]!, pairs[1]!];
    const kicker = highestExcluding(cards, [high.rank, low.rank], 1);
    return rank(
      HandCategory.TWO_PAIR,
      [high.rank, low.rank, rankOf(kicker[0]!)],
      [...pick(cards, high.rank, 2), ...pick(cards, low.rank, 2), ...kicker],
    );
  }

  if (pairs.length === 1) {
    const pair = pairs[0]!;
    const kickers = highestExcluding(cards, [pair.rank], 3);
    return rank(
      HandCategory.PAIR,
      [pair.rank, ...kickers.map(rankOf)],
      [...pick(cards, pair.rank, 2), ...kickers],
    );
  }

  const best = [...cards].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
  return rank(HandCategory.HIGH_CARD, best.map(rankOf), best);
}

/**
 * The five cards of the best straight, high first — or null.
 *
 * The wheel (A-2-3-4-5) is handled by treating the ace as below the deuce, which is the
 * one place in poker where an ace is low. Its high card is the five, not the ace.
 */
function findStraight(cards: readonly Card[]): Card[] | null {
  const present: (Card | undefined)[] = Array(13).fill(undefined);
  for (const card of cards) {
    const r = rankOf(card);
    // Keep any one card per rank; for a straight the suit is irrelevant.
    if (present[r] === undefined) present[r] = card;
  }

  for (let high = 12; high >= 4; high--) {
    const run: Card[] = [];
    for (let offset = 0; offset < 5; offset++) {
      const card = present[high - offset];
      if (card === undefined) break;
      run.push(card);
    }
    if (run.length === 5) return run;
  }

  // The wheel: 5-4-3-2-A.
  const wheel = [3, 2, 1, 0, 12].map((r) => present[r]);
  if (wheel.every((card) => card !== undefined)) return wheel as Card[];

  return null;
}

function groupsByCount(byRank: readonly number[]): Array<{ rank: number; count: number }> {
  const groups: Array<{ rank: number; count: number }> = [];
  for (let r = 12; r >= 0; r--) {
    if (byRank[r]! > 0) groups.push({ rank: r, count: byRank[r]! });
  }
  // Count descending, then rank descending — so `groups[0]` is always the most significant.
  return groups.sort((a, b) => b.count - a.count || b.rank - a.rank);
}

function pick(cards: readonly Card[], targetRank: number, count: number): Card[] {
  return cards.filter((card) => rankOf(card) === targetRank).slice(0, count);
}

function highestExcluding(cards: readonly Card[], excluded: readonly number[], count: number): Card[] {
  return [...cards]
    .filter((card) => !excluded.includes(rankOf(card)))
    .sort((a, b) => rankOf(b) - rankOf(a))
    .slice(0, count);
}

/** Packs category and kickers into one comparable integer (base 16, five kicker slots). */
function rank(category: number, kickers: readonly number[], cards: readonly Card[]): HandRank {
  let value = category;
  for (let i = 0; i < 5; i++) {
    value = value * 16 + (kickers[i] ?? 0);
  }
  return { value, category, cards: [...cards].sort((a, b) => rankOf(b) - rankOf(a)) };
}

export function describe(hand: HandRank): string {
  return CATEGORY_NAMES[hand.category] ?? 'a hand';
}
