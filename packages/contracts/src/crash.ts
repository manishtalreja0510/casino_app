/**
 * Wire contracts for `crash` (P8, `docs/02-domains/crash-game-rules.md`).
 *
 * These types describe what the server says about a round. They deliberately contain no
 * arithmetic the client is expected to perform on money: the multiplier is here so the
 * client can *animate* it, and every amount that matters is computed server-side.
 */

/** Multipliers travel as integers ×100 — 250 is 2.50×. No floats anywhere near money. */
export type MultiplierX100 = number;

export type CrashPhase = 'betting' | 'flying' | 'crashed';

export interface CrashBetView {
  userId: string;
  /** Integer minor units. */
  amount: number;
  /** The multiplier they locked in, or null while they are still riding. */
  cashedOutAtX100: MultiplierX100 | null;
  /** Paid on settlement; null until the round crashes. */
  payout: number | null;
}

/** What every watcher of a round sees — never the seed or the crash point before reveal. */
export interface CrashRoundPublic {
  matchId: string;
  tierId: string;
  phase: CrashPhase;
  /** sha256 of the server seed, published before betting opens. */
  commitment: string;
  /** Epoch ms the betting window closes. Advisory for display; the server owns the clock. */
  betsCloseAt: number | null;
  /** Epoch ms the multiplier started rising. */
  startedAt: number | null;
  /** Milliseconds per multiplier step — the client animates from this, nothing more. */
  tickMs: number;
  /** Growth per step in per-mille (10 = 1%). Sent so the client draws the server's curve
   * rather than carrying its own copy of the rules. Never used to compute money. */
  growthPerMille: number;
  /** Current authoritative multiplier while flying; the final one once crashed. */
  multiplierX100: MultiplierX100;
  /** Only after the crash. Before it, null. */
  crashedAtX100: MultiplierX100 | null;
  /** Only after the crash — this is what makes the round verifiable. */
  serverSeed: string | null;
  bets: CrashBetView[];
  /** Bet bounds and caps, so the client can disable what the server would refuse anyway. */
  limits: { betMin: number; betMax: number; currency: string };
}

export interface PlaceCrashBetRequest {
  /** Integer minor units, within `limits`. */
  amount: number;
  /** Optional auto-cash-out target ×100 (≥ 101). Honoured server-side even if disconnected. */
  autoCashOutX100?: MultiplierX100;
}

export interface CrashBetResponse {
  matchId: string;
  amount: number;
  autoCashOutX100: MultiplierX100 | null;
  balance: number;
}

export interface CrashCashOutResponse {
  matchId: string;
  cashedOutAtX100: MultiplierX100;
  /** What the cash-out is worth. Still paid at settlement, not now. */
  payout: number;
}

/** Room carrying a tier's round lifecycle. Public to authenticated players. */
export function crashRoundRoom(tierId: string): string {
  return `round:${tierId}`;
}

export const CrashEvent = {
  OPEN: 'round:open',
  BET: 'round:bet',
  FLYING: 'round:flying',
  CRASHED: 'round:crashed',
} as const;
