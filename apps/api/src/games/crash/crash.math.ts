import { createHash } from 'node:crypto';

/**
 * Crash's arithmetic, isolated and integer-only.
 *
 * Every number here is an integer. Multipliers are ×100 (250 is 2.50×), money is minor
 * units, time is milliseconds. There is no floating point anywhere in this file, and that
 * is not fastidiousness: `Math.pow` and friends are not guaranteed bit-identical across
 * engines and platforms, and a curve that rounds differently on two machines would settle
 * the same round two different ways. Replay and dispute resolution both depend on this
 * being exactly reproducible, forever, everywhere.
 *
 * Published as the game's rules (`docs/02-domains/crash-game-rules.md`) so a player can
 * recompute any round for themselves.
 */

/** One multiplier step. The curve advances in whole ticks; nothing happens between them. */
export const TICK_MS = 100;

/** Growth per tick in per-mille: 10‰ = 1% compounding every 100 ms. */
export const GROWTH_PER_MILLE = 10;

/** The curve starts at 1.00×. */
export const BASE_X100 = 100;

/**
 * The multiplier after `ticks` steps.
 *
 * Compounding is done by repeated integer multiply-and-floor, with a floor of +1 per tick
 * so the curve cannot stall at low multipliers. Bounded by `maxX100`, which also bounds
 * the loop.
 */
export function multiplierAtTick(ticks: number, maxX100: number): number {
  let m = BASE_X100;
  for (let i = 0; i < ticks; i++) {
    if (m >= maxX100) return maxX100;
    m += Math.max(1, Math.floor((m * GROWTH_PER_MILLE) / 1000));
  }
  return Math.min(m, maxX100);
}

/** The multiplier `elapsedMs` into the flight. Time below a whole tick counts for nothing. */
export function multiplierAtElapsed(elapsedMs: number, maxX100: number): number {
  if (elapsedMs <= 0) return BASE_X100;
  return multiplierAtTick(Math.floor(elapsedMs / TICK_MS), maxX100);
}

/** The first tick at which the curve reaches `targetX100`. */
export function ticksToReach(targetX100: number, maxX100: number): number {
  let m = BASE_X100;
  let ticks = 0;
  while (m < targetX100 && m < maxX100) {
    m += Math.max(1, Math.floor((m * GROWTH_PER_MILLE) / 1000));
    ticks++;
  }
  return ticks;
}

/** Milliseconds from lift-off until the curve reaches `targetX100`. */
export function msToReach(targetX100: number, maxX100: number): number {
  return ticksToReach(targetX100, maxX100) * TICK_MS;
}

/**
 * The crash point, derived from the round's server seed.
 *
 * The seed is committed to (`sha256(seed)` published) before betting opens and revealed
 * after the round, so anyone can check that the outcome was fixed before any bet was
 * placed and that it is exactly what this function produces.
 *
 *   h = sha256(seed)
 *   r = first 8 hex digits of h, as an integer in [0, 2^32)
 *   crash×100 = floor((10000 − edgeBps) × 2^32 / (100 × (2^32 − r)))
 *
 * That is the standard 1/(1−u) crash distribution with the house edge applied as an
 * explicit factor rather than hidden inside the curve — the edge is a disclosed number
 * (`houseEdgeBps`), which is the only honest way to ship it. Results below 1.00× are an
 * instant bust: the round crashes before anyone can cash out, and that is where most of
 * the edge is actually taken.
 */
export function crashPointFromSeed(serverSeed: string, houseEdgeBps: number, maxX100: number): number {
  const hash = createHash('sha256').update(serverSeed).digest('hex');
  const r = Number.parseInt(hash.slice(0, 8), 16);
  const space = 2 ** 32;

  // Every intermediate stays below 2^53, so this is exact integer arithmetic.
  const raw = Math.floor(((10_000 - houseEdgeBps) * space) / (100 * (space - r)));
  return Math.min(Math.max(raw, BASE_X100), maxX100);
}

/**
 * What a bet of `stake` returns when cashed out at `multiplierX100`.
 *
 * Rounds **up**, i.e. in the house's disfavour, per the platform's rounding policy
 * (`docs/04-security/financial-security.md §11`: rake rounds down, player credit rounds
 * up). At most one minor unit per cash-out is involved, and the direction is the point:
 * a written rule that always resolves the same way is what makes a rounding dispute
 * answerable, and there is no version of this product where the answer should be "the
 * house kept the remainder".
 */
export function payoutFor(stake: number, multiplierX100: number): number {
  return Math.ceil((stake * multiplierX100) / 100);
}

/** `sha256(seed)` — the commitment published before betting opens. */
export function commitmentFor(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}
