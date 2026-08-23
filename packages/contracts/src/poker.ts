/**
 * Wire contracts for `poker` (P9, `docs/02-domains/poker.md`).
 *
 * Chips are integers in the table's currency minor units, like every other amount in this
 * system. A client renders what is here and sends intents; it never computes a pot, a
 * legal raise, or who won.
 */

export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';

export type PokerActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';

export type PokerSeatState = 'seated' | 'sitting_out' | 'standing';

export interface PokerBlinds {
  sb: number;
  bb: number;
}

/** What a player may do, and the bounds. Sent only to whoever is to act. */
export interface PokerLegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** Smallest legal total-for-this-street of a bet or raise. */
  minRaiseTo: number;
  maxRaiseTo: number;
  /** Present when raising is unavailable for a rule reason rather than a lack of chips. */
  raiseBlockedReason?: string;
}

/** A seat as everyone at the table sees it. Cards are null unless shown down. */
export interface PokerHandSeat {
  userId: string;
  seat: number;
  stack: number;
  committed: number;
  streetBet: number;
  folded: boolean;
  allIn: boolean;
  cards: string[] | null;
}

/** The caller's own seat — the only place their cards appear. */
export interface PokerOwnSeat {
  seat: number;
  cards: string[];
  stack: number;
  committed: number;
  streetBet: number;
  folded: boolean;
  allIn: boolean;
  timebankMs: number;
  legal: PokerLegalActions | null;
}

export interface PokerHandResult {
  pots: Array<{ amount: number; eligible: string[] }>;
  awards: Array<{ userId: string; amount: number }>;
  returned: Array<{ userId: string; amount: number }>;
  rake: number;
  stacks: Record<string, number>;
  shown: Array<{ userId: string; cards: string[] }>;
}

export interface PokerHandView {
  street: PokerStreet;
  board: string[];
  pot: number;
  currentBet: number;
  minRaise: number;
  blinds: PokerBlinds;
  buttonSeat: number | null;
  /** Whose turn it is. Null between hands and once the hand is over. */
  toAct: string | null;
  /** Epoch ms. Advisory for a countdown; the server owns the deadline. */
  deadlineAt: number | null;
  seats: PokerHandSeat[];
  result: PokerHandResult | null;
  /** Present only in the caller's own view. */
  you?: PokerOwnSeat | null;
}

export interface PokerTableSeat {
  seatNo: number;
  userId: string;
  stack: number;
  state: PokerSeatState;
}

export interface PokerTableView {
  tableId: string;
  name: string;
  tierId: string;
  seatCount: number;
  currency: string;
  blinds: PokerBlinds;
  buyIn: { min: number; max: number };
  /** Realtime room carrying this table's public life. */
  room: string;
  buttonSeat: number;
  handNo: number;
  /** The hand in progress, if any. */
  matchId: string | null;
  seats: PokerTableSeat[];
  hand: PokerHandView | null;
  history: Array<{ matchId: string; handNo: number; pot: number; rake: number; board: string[] }>;
}

export interface PokerTableSummary {
  tableId: string;
  name: string;
  tierId: string;
  blinds: PokerBlinds;
  buyIn: { min: number; max: number };
  seatCount: number;
  seated: number;
  currency: string;
}

export const PokerEvent = {
  HAND_STARTED: 'poker:hand_started',
  HAND_FINISHED: 'poker:hand_finished',
  ACTED: 'poker:acted',
  TO_ACT: 'poker:to_act',
  BOARD: 'poker:board',
  SHOWDOWN: 'poker:showdown',
  AUTO_ACTION: 'poker:auto_action',
  TIMEBANK: 'poker:timebank',
} as const;

export function pokerTableRoom(tableId: string): string {
  return `round:table-${tableId}`;
}
