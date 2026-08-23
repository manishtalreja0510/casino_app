import type { Card } from './cards';

/**
 * NLHE betting rules (`docs/02-domains/poker.md §6`).
 *
 * Kept separate from the reducer for one reason: the *same* function has to decide what a
 * player may do and tell the client what it may offer. If those were two implementations
 * they would disagree, and every disagreement is either a button that does nothing or an
 * action the server accepts that the table did not expect.
 *
 * Bounds are public information — a player is entitled to know the minimum legal raise —
 * so this output goes straight into `playerView` for whoever is to act.
 */

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';

export interface HandSeat {
  readonly userId: string;
  /** Seat number at the table. Stable while seated. */
  readonly seat: number;
  /** Position in deal order from the button's left; decides odd chips and act order. */
  readonly order: number;
  /** Chips in front of the player, not yet in the pot. */
  readonly stack: number;
  /** Total put in this hand. */
  readonly committed: number;
  /** Put in on the current street — what `currentBet` is measured against. */
  readonly streetBet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly cards: readonly Card[];
  /** Shown at showdown. Mucked hands stay in the event log and out of every view. */
  readonly revealed: boolean;
  readonly mucked: boolean;
}

export interface BettingState {
  readonly street: Street;
  readonly seats: readonly HandSeat[];
  /** Highest `streetBet` anyone has reached this street. */
  readonly currentBet: number;
  /** The increment the next full raise must at least match. */
  readonly minRaise: number;
  readonly bigBlind: number;
  /** Acted at least once on this street — how the big blind gets its option. */
  readonly actedThisStreet: readonly string[];
  /**
   * Acted since the last **full** raise.
   *
   * This is the whole of the "an all-in below a full raise does not reopen the action"
   * rule: a short all-in raises `currentBet` without clearing this list, so players on it
   * must still call or fold but may not raise again.
   */
  readonly actedSinceFullRaise: readonly string[];
}

export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** Chips a call costs — capped at the stack, which is a call all-in. */
  readonly callAmount: number;
  readonly canBet: boolean;
  readonly canRaise: boolean;
  /** Smallest legal total-for-this-street of a bet or raise. */
  readonly minRaiseTo: number;
  /** Largest — always the whole stack. */
  readonly maxRaiseTo: number;
  /** Why raising is unavailable, when it is not simply a matter of chips. */
  readonly raiseBlockedReason?: string;
}

export function isLive(seat: HandSeat): boolean {
  return !seat.folded && !seat.allIn;
}

export function contenders(state: BettingState): readonly HandSeat[] {
  return state.seats.filter((seat) => !seat.folded);
}

/** What `userId` may do right now, and the bounds. */
export function legalActions(state: BettingState, userId: string): LegalActions {
  const seat = state.seats.find((s) => s.userId === userId);
  const none: LegalActions = {
    canFold: false,
    canCheck: false,
    canCall: false,
    callAmount: 0,
    canBet: false,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
  };
  if (!seat || !isLive(seat)) return none;

  const toCall = Math.min(state.currentBet - seat.streetBet, seat.stack);
  const facingBet = state.currentBet > seat.streetBet;

  // A player who has already acted since the last full raise may call or fold, never
  // raise: a short all-in moved the bet without reopening the action.
  const alreadyClosed = state.actedSinceFullRaise.includes(userId);

  // The smallest legal total for this street. A raise must lift the bet by at least the
  // last full increment; a first bet must be at least one big blind.
  const minRaiseTo = state.currentBet > 0 ? state.currentBet + state.minRaise : state.bigBlind;
  const maxRaiseTo = seat.streetBet + seat.stack;

  // Below the minimum but holding fewer chips than that: an all-in is always available.
  const canAffordAnyRaise = maxRaiseTo > state.currentBet;

  return {
    canFold: true,
    canCheck: !facingBet,
    canCall: facingBet && toCall > 0,
    callAmount: toCall,
    canBet: state.currentBet === 0 && canAffordAnyRaise,
    canRaise: state.currentBet > 0 && canAffordAnyRaise && !alreadyClosed,
    minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
    maxRaiseTo,
    ...(alreadyClosed && state.currentBet > 0
      ? { raiseBlockedReason: 'an all-in below a full raise does not reopen the action' }
      : {}),
  };
}

/**
 * Validates a bet or raise to `target` total-for-this-street.
 *
 * Returns null when legal, or the reason it is not. The reason is safe to send to the
 * player: it only ever mentions bounds, which are public.
 */
export function validateRaise(state: BettingState, userId: string, target: number): string | null {
  const seat = state.seats.find((s) => s.userId === userId);
  if (!seat) return 'You are not in this hand';

  const legal = legalActions(state, userId);
  if (!legal.canBet && !legal.canRaise) {
    return legal.raiseBlockedReason ?? 'You cannot raise right now';
  }
  if (!Number.isSafeInteger(target)) return 'Bet amounts are whole chips';
  if (target <= state.currentBet) return 'A raise has to be more than the current bet';
  if (target > legal.maxRaiseTo) return 'You do not have that many chips';

  // Under the minimum is legal only when it is everything the player has: that is an
  // all-in, and it is always allowed.
  const isAllIn = target === legal.maxRaiseTo;
  if (target < legal.minRaiseTo && !isAllIn) {
    return `The minimum raise is to ${legal.minRaiseTo}`;
  }
  return null;
}

/** True when nobody has a decision left to make on this street. */
export function bettingRoundComplete(state: BettingState): boolean {
  const live = state.seats.filter(isLive);

  // One player left with chips, everyone else all-in or folded: no more betting is
  // possible, so the street closes even though that player never "acted".
  if (contenders(state).length <= 1) return true;
  if (live.length === 0) return true;
  if (live.length === 1 && live[0]!.streetBet >= state.currentBet) {
    const others = contenders(state).filter((s) => s.userId !== live[0]!.userId);
    if (others.every((s) => s.allIn)) return true;
  }

  return live.every(
    (seat) => seat.streetBet === state.currentBet && state.actedThisStreet.includes(seat.userId),
  );
}

/**
 * Who acts next, as an index into `seats`, or null when the street is over.
 *
 * Walks forward in deal order from `fromIndex`, which is what makes the big blind's option
 * fall out naturally: it has posted but not acted, so it is still owed a turn even when
 * everyone limps.
 */
export function nextToAct(state: BettingState, fromIndex: number): number | null {
  if (bettingRoundComplete(state)) return null;

  const count = state.seats.length;
  for (let step = 1; step <= count; step++) {
    const index = (fromIndex + step) % count;
    const seat = state.seats[index]!;
    if (!isLive(seat)) continue;
    if (seat.streetBet < state.currentBet || !state.actedThisStreet.includes(seat.userId)) {
      return index;
    }
  }
  return null;
}
