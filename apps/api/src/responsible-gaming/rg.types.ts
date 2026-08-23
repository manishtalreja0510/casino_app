/**
 * Responsible-gaming vocabulary (`docs/02-domains/responsible-gaming.md`).
 *
 * Deliberately small and explicit. Every one of these names appears in a regulator-facing
 * conversation eventually, so they match the domain doc's words rather than inventing
 * friendlier ones.
 */

export type LimitType = 'deposit' | 'loss' | 'wager' | 'session_time';
export type LimitPeriod = 'day' | 'week' | 'month';
export type LimitOrigin = 'player' | 'jurisdiction';
export type ExclusionKind = 'cool_off' | 'self_exclusion';

/** What a caller is about to do, and therefore which limits apply. */
export type SpendKind =
  /** Credit into the player's wallet — the faucet today, a deposit at P17. */
  | 'deposit'
  /** Money leaving the wallet to play: a buy-in, a bet, a poker sit-down. */
  | 'wager';

export interface RgLimit {
  id: string;
  userId: string;
  type: LimitType;
  period: LimitPeriod;
  amount: number;
  origin: LimitOrigin;
  pendingAmount: number | null;
  pendingEffectiveAt: Date | null;
}

export interface RgUsage {
  type: LimitType;
  period: LimitPeriod;
  windowStart: Date;
  spent: number;
  returned: number;
}

export interface RgExclusion {
  id: string;
  userId: string;
  kind: ExclusionKind;
  startsAt: Date;
  /** Null means permanent. */
  endsAt: Date | null;
}

/**
 * The answer to "may this happen".
 *
 * A refusal always carries a reason the player can be shown. "No" without a why is how a
 * safety feature becomes a support ticket.
 */
export interface RgDecision {
  allowed: boolean;
  reason?: string;
  /** Which limit refused, for the player-facing message and the RG event. */
  limit?: { type: LimitType; period: LimitPeriod; amount: number; used: number };
}

export const RG_ALLOWED: RgDecision = { allowed: true };

/**
 * How long a *loosening* change waits before it binds.
 *
 * The asymmetry is the whole mechanism: a player who wants to be stricter is taken at their
 * word immediately, and a player who wants more room has to still want it tomorrow. The
 * value is jurisdiction configuration (P15/P18); this is the default the doc names.
 */
export const LIMIT_INCREASE_COOLING_MS = 24 * 60 * 60 * 1000;

/** Bounds a player may set a reality-check interval within. */
export const REALITY_CHECK_MIN_MS = 5 * 60 * 1000;
export const REALITY_CHECK_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * How long an unacknowledged reality check may stand before play is paused.
 *
 * A grace rather than an instant block: the check appears mid-session, and a player who is
 * mid-hand should finish it. Nothing here ever interrupts a hand — see `checkAllowance`.
 */
export const REALITY_CHECK_GRACE_MS = 60 * 1000;

/** Start of the window a period belongs to, for a given moment. */
export function windowStart(period: LimitPeriod, at: Date): Date {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);

  if (period === 'day') return date;

  if (period === 'week') {
    // ISO weeks start on Monday. `getUTCDay()` calls Sunday 0, so shift it to 6.
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    return date;
  }

  date.setUTCDate(1);
  return date;
}

/**
 * The unit a limit of each type is counted in.
 *
 * Money limits are integer minor units, like everything else that touches money (rule 4).
 * A session-time limit is whole **minutes**, metered a minute at a time by the sweep that
 * watches who is connected — the same unit the player sets it in, so nothing converts and
 * nothing rounds.
 */
export function unitOf(type: LimitType): 'minor_units' | 'minutes' {
  return type === 'session_time' ? 'minutes' : 'minor_units';
}

/** Which limit types a spend of this kind is metered against. */
export function typesFor(kind: SpendKind): LimitType[] {
  return kind === 'deposit' ? ['deposit'] : ['wager', 'loss'];
}

/** The adjective a period is called by when a player is told a limit refused them. */
export function periodLabel(period: LimitPeriod): string {
  return period === 'day' ? 'daily' : period === 'week' ? 'weekly' : 'monthly';
}
