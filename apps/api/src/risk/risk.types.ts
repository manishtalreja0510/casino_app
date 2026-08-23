/**
 * Risk vocabulary (`docs/02-domains/fraud-risk.md`, ADR-018).
 */

export type RiskAction = 'flag' | 'limit' | 'require_review' | 'freeze';

export interface RiskSignal {
  /** Where it came from — `client`, `auth`, `wallet`, `poker`. Recorded, never trusted. */
  source: string;
  /** A type from `risk.rules`. An unknown type is ignored rather than given a guessed weight. */
  type: string;
  userId?: string;
  sessionId?: string;
  deviceId?: string;
  matchId?: string;
  payload?: Record<string, unknown>;
}

export interface RiskRule {
  type: string;
  weight: number;
  ttlSeconds: number;
  /**
   * Evidence that exists only because a client said so.
   *
   * Normative (`fraud-risk.md §6`): these may raise a score and trigger flag or limit, and
   * may **never on their own** freeze an account. A rooted phone is not proof of fraud, a
   * clean report is not proof of innocence, and a hard block on either is an oracle that
   * tells an attacker exactly which check to defeat next.
   */
  clientOnly: boolean;
  enabled: boolean;
}

export interface RiskScore {
  userId: string;
  /** Everything live, client and server alike. Drives flag and limit. */
  total: number;
  /**
   * The part of the score the server observed for itself.
   *
   * Freezing is decided on this number alone — which is how "client signals never freeze"
   * stops being a policy someone has to remember and becomes arithmetic.
   */
  serverEvidence: number;
  contributing: Array<{ type: string; weight: number; clientOnly: boolean; at: Date }>;
}

/**
 * Where each rung of the ladder begins.
 *
 * `freeze` is deliberately above the sum of every client-only weight in the seeded rule
 * set (100 — root 15, emulator 10, hook 25, signature 30, integrity 20), so a device
 * reporting *every* problem at once still cannot reach it even if the `serverEvidence`
 * check in `evaluate` were removed. Two independent reasons the normative rule holds,
 * because one of them is a number somebody could later edit — which is exactly what makes
 * the margin worth stating: at 100 the two would have been equal and the second reason
 * would have been decoration.
 *
 * The gap costs little. Corroborated server evidence clears it comfortably — a chip dump
 * between linked accounts (70) with the shared device that linked them (20) and co-seating
 * (20) is 110, and adding any fourth finding passes 120 — while a single strong heuristic
 * on its own lands on `require_review`, which is where a v1 heuristic belongs.
 */
export const RISK_THRESHOLDS = {
  flag: 25,
  limit: 45,
  requireReview: 70,
  freeze: 120,
} as const;

/** What a caller is allowed to do, given the actions standing against them. */
export interface RiskGate {
  allowed: boolean;
  action?: RiskAction;
  reason?: string;
}

export const RISK_ALLOWED: RiskGate = { allowed: true };

/**
 * The support path every freeze carries.
 *
 * There are no silent freezes (`fraud-risk.md §9`): a player who cannot move their money
 * is always told that a human can look at it. Until notifications exist (P11) this message
 * is the channel.
 */
export const FROZEN_MESSAGE =
  'Your account is on hold while we review it. Contact support and someone will look at your case.';
