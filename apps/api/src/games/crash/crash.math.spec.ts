import { createHash } from 'node:crypto';
import {
  BASE_X100,
  TICK_MS,
  commitmentFor,
  crashPointFromSeed,
  msToReach,
  multiplierAtElapsed,
  multiplierAtTick,
  payoutFor,
  ticksToReach,
} from './crash.math';

const MAX = 10_000;
const EDGE_BPS = 300;

describe('crash curve', () => {
  it('starts at 1.00x and never goes backwards', () => {
    expect(multiplierAtTick(0, MAX)).toBe(BASE_X100);

    let previous = BASE_X100;
    for (let tick = 1; tick <= 600; tick++) {
      const current = multiplierAtTick(tick, MAX);
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(Number.isSafeInteger(current)).toBe(true);
      previous = current;
    }
  });

  it('is capped, and stays capped', () => {
    expect(multiplierAtTick(10_000, MAX)).toBe(MAX);
    expect(multiplierAtTick(100_000, MAX)).toBe(MAX);
  });

  it('advances only on whole ticks — time in between buys nothing', () => {
    expect(multiplierAtElapsed(0, MAX)).toBe(BASE_X100);
    expect(multiplierAtElapsed(TICK_MS - 1, MAX)).toBe(BASE_X100);
    expect(multiplierAtElapsed(TICK_MS, MAX)).toBe(multiplierAtTick(1, MAX));
    expect(multiplierAtElapsed(TICK_MS * 3 + 99, MAX)).toBe(multiplierAtTick(3, MAX));
  });

  it('treats a negative elapsed time as lift-off rather than as a rewind', () => {
    // Clock reads are recorded, not trusted to be ordered — a skew must not price a
    // cash-out below 1.00x, which would be a payout smaller than the stake.
    expect(multiplierAtElapsed(-5_000, MAX)).toBe(BASE_X100);
  });

  it('ticksToReach agrees with the curve it is inverting', () => {
    for (const target of [101, 150, 200, 500, 1_000, 5_000, MAX]) {
      const ticks = ticksToReach(target, MAX);
      expect(multiplierAtTick(ticks, MAX)).toBeGreaterThanOrEqual(Math.min(target, MAX));
      if (ticks > 0) expect(multiplierAtTick(ticks - 1, MAX)).toBeLessThan(target);
      expect(msToReach(target, MAX)).toBe(ticks * TICK_MS);
    }
  });

  it('grows at the advertised 1% per tick once rounding stops biting', () => {
    // At low multipliers the +1 floor dominates; by 2.00x the compounding is exact.
    const at200 = multiplierAtTick(ticksToReach(200, MAX), MAX);
    const next = multiplierAtTick(ticksToReach(200, MAX) + 1, MAX);
    expect(next - at200).toBe(Math.floor(at200 / 100));
  });
});

describe('crash point', () => {
  it('is exactly the published function of the seed', () => {
    const seed = 'a'.repeat(64);
    const r = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
    const expected = Math.floor(((10_000 - EDGE_BPS) * 2 ** 32) / (100 * (2 ** 32 - r)));

    expect(crashPointFromSeed(seed, EDGE_BPS, MAX)).toBe(
      Math.min(Math.max(expected, BASE_X100), MAX),
    );
  });

  it('never leaves [1.00x, cap]', () => {
    for (let i = 0; i < 2_000; i++) {
      const point = crashPointFromSeed(`seed-${i}`, EDGE_BPS, MAX);
      expect(point).toBeGreaterThanOrEqual(BASE_X100);
      expect(point).toBeLessThanOrEqual(MAX);
      expect(Number.isSafeInteger(point)).toBe(true);
    }
  });

  it('is deterministic — the same seed always gives the same round', () => {
    expect(crashPointFromSeed('fixed', EDGE_BPS, MAX)).toBe(crashPointFromSeed('fixed', EDGE_BPS, MAX));
  });

  it('produces the distribution the house edge implies', () => {
    // The median of 1/(1-u) is 2x before the edge; with a 3% edge it lands just under
    // 1.94x. Checked as a band rather than a point: the claim is that the edge is real and
    // is where the docs say it is, not that 2000 samples hit an exact quantile.
    const samples = Array.from({ length: 4_000 }, (_, i) =>
      crashPointFromSeed(`dist-${i}`, EDGE_BPS, MAX),
    ).sort((a, b) => a - b);

    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeGreaterThan(170);
    expect(median).toBeLessThan(220);

    // Roughly 3% of rounds are instant busts — that is where the edge is mostly taken.
    const instantBusts = samples.filter((point) => point === BASE_X100).length;
    expect(instantBusts / samples.length).toBeGreaterThan(0.01);
    expect(instantBusts / samples.length).toBeLessThan(0.06);
  });

  it('takes more of the pot as the edge rises', () => {
    let lowEdgeTotal = 0;
    let highEdgeTotal = 0;
    for (let i = 0; i < 1_000; i++) {
      lowEdgeTotal += crashPointFromSeed(`edge-${i}`, 0, MAX);
      highEdgeTotal += crashPointFromSeed(`edge-${i}`, 1_000, MAX);
    }
    expect(highEdgeTotal).toBeLessThan(lowEdgeTotal);
  });
});

describe('payout', () => {
  it('rounds in the house’s disfavour, per the platform rounding policy', () => {
    // 333 x 1.50 = 499.5. The half unit goes to the player, always and by rule
    // (financial-security.md §11) — never to whoever happens to be holding it.
    expect(payoutFor(333, 150)).toBe(500);
    expect(payoutFor(1_000, 100)).toBe(1_000);
    expect(payoutFor(0, 5_000)).toBe(0);
  });

  it('never pays a player less than their stake times the multiplier', () => {
    for (let stake = 1; stake <= 999; stake += 7) {
      for (const multiplier of [100, 101, 150, 233, 1_007, 9_999]) {
        const payout = payoutFor(stake, multiplier);
        expect(payout * 100).toBeGreaterThanOrEqual(stake * multiplier);
        // …and never more than a single minor unit above it.
        expect(payout * 100 - stake * multiplier).toBeLessThan(100);
      }
    }
  });

  it('always returns at least the stake back at 1.00x', () => {
    for (let stake = 0; stake <= 5_000; stake += 37) {
      expect(payoutFor(stake, 100)).toBe(stake);
    }
  });
});

describe('commitment', () => {
  it('is the sha256 anyone can check', () => {
    const seed = 'deadbeef';
    expect(commitmentFor(seed)).toBe(createHash('sha256').update(seed).digest('hex'));
  });
});
