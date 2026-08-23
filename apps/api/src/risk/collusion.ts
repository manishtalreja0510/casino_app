/**
 * Poker collusion and chip-dumping heuristics, v1 (`docs/02-domains/fraud-risk.md §3`).
 *
 * Pure functions over hand summaries, so the judgement is testable without a table, a deck
 * or a database. What they are *not* is proof: every one of these fires on honest play
 * sometimes — two friends genuinely do sit together, and one player genuinely does lose
 * five all-ins to the same opponent. That is why the output is a score contribution and a
 * case, never an automatic freeze on its own.
 */

export interface HandSummary {
  matchId: string;
  tableId: string;
  /** Net chips per player for this hand: positive won, negative lost. Sums to −rake. */
  net: Record<string, number>;
  at: Date;
}

export interface PairFlow {
  a: string;
  b: string;
  /** Hands the pair sat in together. */
  handsTogether: number;
  /** Net chips that moved from `b` to `a` across those hands. */
  netToA: number;
  /** Total chips the pair moved between them, regardless of direction. */
  volume: number;
}

/**
 * Aggregates pairwise chip flow across hands.
 *
 * Only pairs where one won and the other lost in the same hand are counted — in a
 * multi-way pot the chips did not necessarily move between any particular two players, so
 * attributing them would manufacture evidence.
 */
export function pairFlows(hands: readonly HandSummary[]): PairFlow[] {
  const pairs = new Map<string, PairFlow>();

  for (const hand of hands) {
    const winners = Object.entries(hand.net).filter(([, net]) => net > 0);
    const losers = Object.entries(hand.net).filter(([, net]) => net < 0);

    for (const [winner, won] of winners) {
      for (const [loser, lost] of losers) {
        // The most that can be said to have moved between these two.
        const moved = Math.min(won, -lost);
        const [a, b] = winner < loser ? [winner, loser] : [loser, winner];
        const key = `${a}|${b}`;
        const entry = pairs.get(key) ?? { a, b, handsTogether: 0, netToA: 0, volume: 0 };

        entry.volume += moved;
        entry.netToA += winner === a ? moved : -moved;
        pairs.set(key, entry);
      }
    }
  }

  // Hands together is counted per pair per hand, not per winner/loser combination.
  for (const hand of hands) {
    const players = Object.keys(hand.net);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const [a, b] = players[i]! < players[j]! ? [players[i]!, players[j]!] : [players[j]!, players[i]!];
        const entry = pairs.get(`${a}|${b}`);
        if (entry) entry.handsTogether++;
      }
    }
  }

  return [...pairs.values()];
}

export interface DumpFinding {
  from: string;
  to: string;
  netChips: number;
  handsTogether: number;
  /** How one-sided the flow was, 0..1. 1 means every chip went the same way. */
  asymmetry: number;
}

/**
 * Flags pairs whose chip flow is too one-sided to look like poker.
 *
 * Two conditions have to hold together, and the second is what keeps this from firing on
 * every good player at the table: the flow must be nearly all one direction (**asymmetry**),
 * *and* the pair must have played enough hands for that to be unlikely. A single big pot is
 * variance; twenty hands where every chip went one way is not.
 */
export function detectChipDumping(
  flows: readonly PairFlow[],
  options: { minHands?: number; minAsymmetry?: number; minVolume?: number } = {},
): DumpFinding[] {
  const minHands = options.minHands ?? 8;
  const minAsymmetry = options.minAsymmetry ?? 0.85;
  const minVolume = options.minVolume ?? 1;

  const findings: DumpFinding[] = [];

  for (const flow of flows) {
    if (flow.handsTogether < minHands || flow.volume < minVolume) continue;

    const asymmetry = Math.abs(flow.netToA) / flow.volume;
    if (asymmetry < minAsymmetry) continue;

    findings.push({
      from: flow.netToA > 0 ? flow.b : flow.a,
      to: flow.netToA > 0 ? flow.a : flow.b,
      netChips: Math.abs(flow.netToA),
      handsTogether: flow.handsTogether,
      asymmetry,
    });
  }

  return findings;
}

/**
 * Flags pairs who sit together far more than chance would explain.
 *
 * The comparison is against how often each of them plays at all: two players who each
 * played 100 hands but 90 of them together are not choosing tables independently. Two who
 * played 10 hands each, all together, are a coincidence — which is why a minimum sample
 * applies before the ratio means anything.
 */
export function detectCoSeating(
  flows: readonly PairFlow[],
  handsPerPlayer: Readonly<Record<string, number>>,
  options: { minHands?: number; minShare?: number } = {},
): Array<{ a: string; b: string; share: number; handsTogether: number }> {
  const minHands = options.minHands ?? 20;
  const minShare = options.minShare ?? 0.7;

  const findings: Array<{ a: string; b: string; share: number; handsTogether: number }> = [];

  for (const flow of flows) {
    const playedA = handsPerPlayer[flow.a] ?? 0;
    const playedB = handsPerPlayer[flow.b] ?? 0;
    if (playedA < minHands || playedB < minHands) continue;

    // Share of the *less active* player's hands spent with the other. Using the smaller
    // denominator avoids a busy regular being flagged by a casual player who only ever
    // shows up at their table — which is the casual player's pattern, not the regular's.
    const share = flow.handsTogether / Math.min(playedA, playedB);
    if (share >= minShare) {
      findings.push({ a: flow.a, b: flow.b, share, handsTogether: flow.handsTogether });
    }
  }

  return findings;
}
