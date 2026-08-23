import { z } from 'zod';

/**
 * Table configuration (`docs/02-domains/poker.md §12`).
 *
 * Stored per table and copied into a hand's match config when it is dealt, so a hand is
 * played and settled under the configuration it started with even if the table is retuned
 * between hands.
 */
export const pokerConfigSchema = z.object({
  blinds: z.object({
    sb: z.number().int().min(1),
    bb: z.number().int().min(2),
  }),
  /** Buy-in bounds in chips (the table stores them; the tier states them in big blinds). */
  buyIn: z.object({
    min: z.number().int().min(0),
    max: z.number().int().min(0),
  }),
  turnTimerMs: z.number().int().min(3_000).max(120_000),
  timebankMs: z.number().int().min(0).max(300_000),
  /** How much timebank one expiry consumes before the server acts. */
  timebankStepMs: z.number().int().min(1_000).max(60_000),
  /** Capped percentage of the pot. **Zero on TST** — see the migration. */
  rake: z.object({
    bps: z.number().int().min(0).max(1_000),
    cap: z.number().int().min(0),
  }),
  /** Which position holds the button for this hand — the table rotates it. */
  buttonOrder: z.number().int().min(0).max(5),
  /** Losing hands muck at showdown rather than being shown. */
  muckLosers: z.boolean(),
});

export type PokerConfig = z.infer<typeof pokerConfigSchema>;

/**
 * Defaults for a table whose config will not parse.
 *
 * Conservative in the direction that matters: **no rake**. A misconfigured table that
 * quietly started charging players would be far worse than one that quietly stopped.
 */
export const POKER_CONFIG_FALLBACK: PokerConfig = {
  blinds: { sb: 1, bb: 2 },
  buyIn: { min: 40, max: 200 },
  turnTimerMs: 15_000,
  timebankMs: 30_000,
  timebankStepMs: 10_000,
  rake: { bps: 0, cap: 0 },
  buttonOrder: 0,
  muckLosers: true,
};

export function parsePokerConfig(raw: unknown): { config: PokerConfig; error?: string } {
  const parsed = pokerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { config: POKER_CONFIG_FALLBACK, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  if (parsed.data.blinds.bb <= parsed.data.blinds.sb) {
    return { config: POKER_CONFIG_FALLBACK, error: 'the big blind must exceed the small blind' };
  }
  if (parsed.data.buyIn.max < parsed.data.buyIn.min) {
    return { config: POKER_CONFIG_FALLBACK, error: 'buy-in max is below min' };
  }
  return { config: parsed.data };
}
