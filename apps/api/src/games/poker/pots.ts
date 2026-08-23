import { evaluate, type Card } from './cards';

/**
 * Pot construction and award (`docs/02-domains/poker.md §6` — normative).
 *
 * This is where chips are conserved or quietly lost, so the whole file is written to make
 * one property checkable: **every chip a player committed is either awarded, returned, or
 * raked.** Nothing rounds away, and the odd chip of a split has a named owner rather than
 * whoever the sort happened to put first.
 */

export interface PotPlayer {
  readonly userId: string;
  /** Total chips put in this hand, across blinds and every street. */
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** Hole cards. Absent for a player whose cards are never evaluated (folded, or mucked). */
  readonly cards?: readonly Card[];
  /** Deal order from the button's left — decides who gets an odd chip. */
  readonly order: number;
}

export interface Pot {
  readonly amount: number;
  /** Players who may win this layer. */
  readonly eligible: readonly string[];
}

export interface Award {
  readonly userId: string;
  readonly amount: number;
}

export interface Showdown {
  readonly pots: readonly Pot[];
  readonly awards: readonly Award[];
  /** Returned to a bettor whose bet nobody could match. */
  readonly returned: readonly Award[];
  readonly rake: number;
  /** Best hand per player still in at showdown — the reveal. */
  readonly ranked: ReadonlyArray<{ userId: string; value: number; cards: readonly Card[] }>;
}

/**
 * Returns the uncalled excess to its owner **before** pots are built (§6.1).
 *
 * If one player committed more than anyone else could match, the difference was never at
 * risk: nobody could win it, so it is not a pot, it is their chips. Building pots first and
 * refunding afterwards would create a layer with exactly one eligible player — the same
 * money, recorded as a pot they "won", which misreports every metric downstream.
 */
export function returnUncalled(players: readonly PotPlayer[]): {
  players: PotPlayer[];
  returned: Award[];
} {
  // The most anyone *else* could have matched.
  const sorted = [...players].map((p) => p.committed).sort((a, b) => b - a);
  const highest = sorted[0] ?? 0;
  const secondHighest = sorted[1] ?? 0;
  if (highest === 0 || highest === secondHighest) return { players: [...players], returned: [] };

  const excess = highest - secondHighest;
  const owner = players.find((p) => p.committed === highest)!;

  return {
    players: players.map((p) =>
      p.userId === owner.userId ? { ...p, committed: p.committed - excess } : p,
    ),
    returned: [{ userId: owner.userId, amount: excess }],
  };
}

/**
 * Builds the main pot and any side pots (§6.2–6.4).
 *
 * Layers are cut at each distinct all-in commitment. A folded player's chips are *in* the
 * layers — they lost them — but a folded player is never eligible to win one.
 */
export function buildPots(players: readonly PotPlayer[]): Pot[] {
  const levels = [
    ...new Set(
      players
        .filter((p) => !p.folded && p.allIn)
        .map((p) => p.committed)
        .filter((amount) => amount > 0),
    ),
  ].sort((a, b) => a - b);

  const maxLive = Math.max(0, ...players.filter((p) => !p.folded).map((p) => p.committed));
  if (maxLive > 0 && levels.at(-1) !== maxLive) levels.push(maxLive);

  const pots: Pot[] = [];
  let previous = 0;

  for (const level of levels) {
    let amount = 0;
    for (const player of players) {
      amount += Math.min(player.committed, level) - Math.min(player.committed, previous);
    }

    const eligible = players.filter((p) => !p.folded && p.committed >= level).map((p) => p.userId);

    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
    previous = level;
  }

  return pots;
}

/**
 * Awards pots to the best eligible hands, taking rake from the total first.
 *
 * `rake` is computed by the caller — it is table configuration, not a property of the
 * cards — and deducted **proportionally across pots**, so a side pot a short stack could
 * not contest does not carry the whole charge.
 */
export function settleShowdown(input: {
  players: readonly PotPlayer[];
  board: readonly Card[];
  rake: number;
}): Showdown {
  const { players: adjusted, returned } = returnUncalled(input.players);
  const pots = buildPots(adjusted);

  const ranked = adjusted
    .filter((p) => !p.folded && p.cards && p.cards.length > 0)
    .map((p) => {
      const best = evaluate([...p.cards!, ...input.board]);
      return { userId: p.userId, value: best.value, cards: best.cards };
    })
    .sort((a, b) => b.value - a.value);

  const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
  const rake = Math.max(0, Math.min(input.rake, total));

  const byUser = new Map<string, number>();
  let rakeTaken = 0;

  pots.forEach((pot, index) => {
    // Proportional share of the rake, with the remainder on the last pot so the total taken
    // is exactly `rake` — never a rounding artefact more or less.
    const share =
      index === pots.length - 1
        ? rake - rakeTaken
        : Math.floor((rake * pot.amount) / Math.max(total, 1));
    rakeTaken += share;

    const payable = pot.amount - share;
    const contenders = ranked.filter((entry) => pot.eligible.includes(entry.userId));
    const best = contenders.length > 0 ? Math.max(...contenders.map((c) => c.value)) : null;

    // Nobody eligible has a ranked hand (everyone else folded, or mucked): the eligible
    // player takes it uncontested. With one contender there is no showdown to rank.
    const winners =
      best === null
        ? pot.eligible.slice(0, 1)
        : contenders.filter((c) => c.value === best).map((c) => c.userId);

    const each = Math.floor(payable / winners.length);
    const remainder = payable - each * winners.length;

    // The odd chip goes to the eligible winner closest to the button's left (§6.5) — a
    // named rule, so two implementations agree and a player can be told why.
    const byOrder = [...winners].sort((a, b) => orderOf(adjusted, a) - orderOf(adjusted, b));

    byOrder.forEach((userId, position) => {
      const amount = each + (position < remainder ? 1 : 0);
      byUser.set(userId, (byUser.get(userId) ?? 0) + amount);
    });
  });

  const awards = [...byUser.entries()].map(([userId, amount]) => ({ userId, amount }));

  // The invariant this file exists for, asserted rather than assumed.
  //
  // Every chip committed must end up awarded, returned, or raked. A state where that does
  // not hold is one the game cannot legitimately reach — a folded player out-committing
  // everyone still live, say — and the correct response is to stop, not to redistribute.
  // A throw here leaves the match in `settling` for a human to look at, which is exactly
  // what the wallet does when settlement instructions do not match escrow
  // (`docs/02-domains/wallet.md §8`). Losing chips quietly is the outcome worth preventing.
  const committed = input.players.reduce((sum, p) => sum + p.committed, 0);
  const accounted =
    awards.reduce((sum, a) => sum + a.amount, 0) +
    returned.reduce((sum, a) => sum + a.amount, 0) +
    rake;

  if (accounted !== committed) {
    throw new Error(
      `pot construction lost chips: ${committed} committed, ${accounted} accounted for`,
    );
  }

  return { pots, awards, returned, rake, ranked };
}

function orderOf(players: readonly PotPlayer[], userId: string): number {
  return players.find((p) => p.userId === userId)?.order ?? 0;
}
