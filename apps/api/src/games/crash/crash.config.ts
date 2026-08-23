import { z } from 'zod';

/**
 * Round configuration (`docs/02-domains/casino-game.md §6`).
 *
 * Stored per stake tier in `game.stake_tiers.config` and copied into the match's config
 * when the round opens, so a round is settled by the configuration it started under even
 * if the tier is retuned mid-flight.
 */
export const crashConfigSchema = z.object({
  /** Bet bounds in integer minor units. */
  betMin: z.number().int().min(0),
  betMax: z.number().int().min(0),
  /** Total stake accepted in one round. */
  maxRoundStake: z.number().int().min(0),
  /** Worst case the house will carry on one round, over and above escrowed stakes. */
  maxHouseExposure: z.number().int().min(0),
  bettingWindowMs: z.number().int().min(1_000).max(60_000),
  interRoundMs: z.number().int().min(0).max(60_000),
  /** Disclosed, never hidden inside the curve. 300 = 3%. */
  houseEdgeBps: z.number().int().min(0).max(2_000),
  /** The multiplier cap, which is also the worst-case payout multiple. */
  maxMultiplierX100: z.number().int().min(200).max(1_000_000),
});

export type CrashConfig = z.infer<typeof crashConfigSchema>;

/**
 * Defaults for a tier whose config is missing or unparseable.
 *
 * Deliberately the most conservative shape rather than the most playable one: zero bets,
 * zero exposure. A misconfigured tier degrades to free play instead of accepting real
 * stakes under guessed limits.
 */
export const CRASH_CONFIG_FALLBACK: CrashConfig = {
  betMin: 0,
  betMax: 0,
  maxRoundStake: 0,
  maxHouseExposure: 0,
  bettingWindowMs: 7_000,
  interRoundMs: 5_000,
  houseEdgeBps: 300,
  maxMultiplierX100: 10_000,
};

export function parseCrashConfig(raw: unknown): { config: CrashConfig; error?: string } {
  const parsed = crashConfigSchema.safeParse(raw);
  if (parsed.success) {
    if (parsed.data.betMax < parsed.data.betMin) {
      return { config: CRASH_CONFIG_FALLBACK, error: 'betMax is below betMin' };
    }
    return { config: parsed.data };
  }
  return { config: CRASH_CONFIG_FALLBACK, error: parsed.error.issues[0]?.message ?? 'invalid config' };
}
