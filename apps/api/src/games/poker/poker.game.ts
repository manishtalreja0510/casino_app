import type {
  GameAction,
  GameContext,
  GameDefinition,
  GamePlayer,
  ReduceResult,
  SettlementInstruction,
} from '@casino/contracts';
import { cardNames, shuffle, type Card } from './cards';
import {
  contenders,
  isLive,
  legalActions,
  nextToAct,
  validateRaise,
  type BettingState,
  type HandSeat,
  type Street,
} from './betting';
import { settleShowdown, type PotPlayer } from './pots';
import { parsePokerConfig, type PokerConfig } from './poker.config';

/**
 * `poker` — one hand of No-Limit Texas Hold'em (P9, OQ-07).
 *
 * A hand is one engine match. Stacks are **not** money in this file: they are game state,
 * backed by a table-scoped escrow the poker module manages (ADR-025). A hand therefore
 * moves no money at all except rake — which is why `settle` returns nothing and `rakeFor`
 * exists instead.
 *
 * The reducer is pure, like every other game's, and that is load-bearing here in a way it
 * is not elsewhere: the deck lives in state, so replaying the event log reproduces the
 * exact cards — which is how a disputed hand is answered and how a crashed table resumes
 * mid-hand rather than voiding.
 *
 * The one thing to be most careful about is `playerView`. It is the only path state takes
 * to a client, and this is the first game where a leak costs someone real money.
 */

export interface PokerState extends BettingState {
  /** Cards not yet dealt. **Never** in any view — see `playerView`. */
  readonly deck: readonly Card[];
  readonly board: readonly Card[];
  readonly seats: readonly HandSeat[];
  /** Index into `seats` of the button. */
  readonly buttonIndex: number;
  readonly toActIndex: number | null;
  readonly blinds: { readonly sb: number; readonly bb: number };
  /** Recorded at `init` — the restore point if this hand has to be voided. */
  readonly startingStacks: Readonly<Record<string, number>>;
  /** Epoch ms of the current turn deadline; server-owned, cosmetic to the client. */
  readonly deadlineAt: number | null;
  /** Remaining timebank per player, consumed before an auto-action. */
  readonly timebank: Readonly<Record<string, number>>;
  readonly result: PokerResult | null;
}

export interface PokerResult {
  readonly pots: ReadonlyArray<{ amount: number; eligible: readonly string[] }>;
  readonly awards: ReadonlyArray<{ userId: string; amount: number }>;
  readonly returned: ReadonlyArray<{ userId: string; amount: number }>;
  readonly rake: number;
  /** Final stacks — what the table persists once the hand settles. */
  readonly stacks: Readonly<Record<string, number>>;
  /** Hands shown at showdown. A mucked hand is not here. */
  readonly shown: ReadonlyArray<{ userId: string; cards: readonly string[] }>;
}

export const TURN_TIMER_ID = 'turn';

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

export const poker: GameDefinition<PokerState> = {
  meta: {
    code: 'poker',
    name: "No-Limit Texas Hold'em",
    version: 1,
    minPlayers: 2,
    maxPlayers: 6,
    turnTimeoutMs: 15_000,
    // Seats are taken at the table, not by a queue; a hand is dealt to whoever is sitting.
    mode: 'rounds',
    // Chips are game state; only rake leaves the table (ADR-025).
    banking: 'table',
  },

  init(ctx: GameContext): PokerState {
    const config = parsePokerConfig(ctx.config).config;
    const deck = shuffle(ctx.random);

    // `ctx.players` arrives in deal order — the table decides who is dealt in and where
    // the button is, because that is a property of the table, not of the hand.
    const ordered = [...ctx.players].sort((a, b) => seatMetaOf(a).order - seatMetaOf(b).order);

    let cursor = 0;
    const seats: HandSeat[] = ordered.map((player) => {
      const meta = seatMetaOf(player);
      return {
        userId: player.userId,
        seat: meta.seat,
        order: meta.order,
        stack: meta.stack,
        committed: 0,
        streetBet: 0,
        folded: false,
        allIn: false,
        cards: [deck[cursor++]!, deck[cursor++]!],
        revealed: false,
        mucked: false,
      };
    });

    const startingStacks = Object.fromEntries(seats.map((s) => [s.userId, s.stack]));
    const buttonIndex = Math.min(config.buttonOrder, seats.length - 1);

    // Heads-up is the exception the rules make everywhere: the button posts the small
    // blind and acts first before the flop, then last on every street after it.
    const headsUp = seats.length === 2;
    const sbIndex = headsUp ? buttonIndex : (buttonIndex + 1) % seats.length;
    const bbIndex = headsUp ? (buttonIndex + 1) % seats.length : (buttonIndex + 2) % seats.length;

    const withBlinds = seats.map((seat, index) => {
      if (index === sbIndex) return post(seat, config.blinds.sb);
      if (index === bbIndex) return post(seat, config.blinds.bb);
      return seat;
    });

    const state: PokerState = {
      street: 'preflop',
      deck: deck.slice(cursor),
      board: [],
      seats: withBlinds,
      buttonIndex,
      toActIndex: null,
      currentBet: Math.max(...withBlinds.map((s) => s.streetBet)),
      // The first raise before the flop must be at least a big blind on top.
      minRaise: config.blinds.bb,
      bigBlind: config.blinds.bb,
      // Posting a blind is not acting: the big blind is still owed its option.
      actedThisStreet: [],
      actedSinceFullRaise: [],
      blinds: config.blinds,
      startingStacks,
      deadlineAt: null,
      timebank: Object.fromEntries(seats.map((s) => [s.userId, config.timebankMs])),
      result: null,
    };

    return openStreet(state, ctx, headsUp ? bbIndex : bbIndex, config);
  },

  reduce(ctx: GameContext, state: PokerState, action: GameAction): ReduceResult<PokerState> {
    const config = parsePokerConfig(ctx.config).config;
    if (state.street === 'complete') throw new Error('This hand is over');

    const index = state.seats.findIndex((seat) => seat.userId === action.userId);
    if (index < 0) throw new Error('You are not in this hand');

    // Identity comes from the authenticated action, never from the payload. A payload that
    // names a seat is ignored — there is nowhere for it to be read.
    if (state.toActIndex !== index) throw new Error('It is not your turn');

    switch (action.type) {
      case 'fold':
        return applyFold(ctx, state, index, config);
      case 'check':
        return applyCheck(ctx, state, index, config);
      case 'call':
        return applyCall(ctx, state, index, config);
      case 'bet':
      case 'raise':
        return applyRaise(ctx, state, index, Number(action.payload?.amount), config);
      case 'allIn':
        return applyRaise(ctx, state, index, allInTarget(state.seats[index]!), config);
      default:
        throw new Error(`Unknown action "${action.type}"`);
    }
  },

  /**
   * The turn clock expired.
   *
   * Timebank first, then the server acts for the player: **check if legal, otherwise
   * fold**. Never a call — spending someone's chips because their connection dropped is
   * not a decision the server gets to make on their behalf.
   */
  onTimeout(ctx: GameContext, state: PokerState, timerId: string): ReduceResult<PokerState> {
    if (timerId !== TURN_TIMER_ID || state.toActIndex === null || state.street === 'complete') {
      return { state, events: [] };
    }

    const config = parsePokerConfig(ctx.config).config;
    const seat = state.seats[state.toActIndex]!;
    const bank = state.timebank[seat.userId] ?? 0;

    if (bank > 0) {
      const spend = Math.min(bank, config.timebankStepMs);
      return {
        state: {
          ...state,
          timebank: { ...state.timebank, [seat.userId]: bank - spend },
          deadlineAt: ctx.now() + spend,
        },
        events: [
          { type: 'poker:timebank', payload: { userId: seat.userId, remainingMs: bank - spend } },
        ],
        timer: { id: TURN_TIMER_ID, delayMs: spend },
      };
    }

    const legal = legalActions(state, seat.userId);
    const auto = legal.canCheck
      ? applyCheck(ctx, state, state.toActIndex, config)
      : applyFold(ctx, state, state.toActIndex, config);

    return {
      ...auto,
      events: [
        { type: 'poker:auto_action', payload: { userId: seat.userId, action: legal.canCheck ? 'check' : 'fold' } },
        ...auto.events,
      ],
    };
  },

  /**
   * What one player sees.
   *
   * The deck and every other player's hole cards are in state and neither leaves this
   * function. Written as an allow-list rather than a redaction: a redaction is a list of
   * things to remember to remove, and the first thing anyone forgets is the newest field.
   */
  playerView(ctx: GameContext, state: PokerState, userId: string): Record<string, unknown> {
    const seat = state.seats.find((s) => s.userId === userId);

    return {
      ...publicHand(state),
      you: seat
        ? {
            seat: seat.seat,
            // The only place a player's own cards appear, and only for their owner.
            cards: cardNames(seat.cards),
            stack: seat.stack,
            committed: seat.committed,
            streetBet: seat.streetBet,
            folded: seat.folded,
            allIn: seat.allIn,
            timebankMs: state.timebank[userId] ?? 0,
            // Bounds are public information; a player is entitled to know the legal raise.
            legal: state.toActIndex !== null && state.seats[state.toActIndex]!.userId === userId
              ? legalActions(state, userId)
              : null,
          }
        : null,
    };
  },

  publicView(ctx: GameContext, state: PokerState): Record<string, unknown> {
    return publicHand(state);
  },

  /** The turn deadline, re-armed after a restart with whatever is left of it. */
  pendingTimer(ctx: GameContext, state: PokerState): { id: string; delayMs: number } | null {
    if (state.street === 'complete' || state.toActIndex === null || state.deadlineAt === null) {
      return null;
    }
    return { id: TURN_TIMER_ID, delayMs: Math.max(0, state.deadlineAt - ctx.now()) };
  },

  isTerminal(state: PokerState): boolean {
    return state.street === 'complete';
  },

  /**
   * No payouts. Chips are game state; the table's escrow already holds them.
   *
   * Returning an empty list is the honest answer for a table-banked game, and the engine
   * does not call it — `rakeFor` is what it asks (ADR-025).
   */
  settle(): SettlementInstruction[] {
    return [];
  },

  /** The only money that leaves the table on a hand. Zero on `TST`. */
  rakeFor(ctx: GameContext, state: PokerState): number {
    return state.result?.rake ?? 0;
  },
};

// --- actions ---------------------------------------------------------------

function applyFold(
  ctx: GameContext,
  state: PokerState,
  index: number,
  config: PokerConfig,
): ReduceResult<PokerState> {
  const seat = state.seats[index]!;
  const seats = replace(state.seats, index, { ...seat, folded: true });
  const next = markActed({ ...state, seats }, seat.userId);

  return advance(next, ctx, index, config, [
    { type: 'poker:acted', payload: { userId: seat.userId, action: 'fold' } },
  ]);
}

function applyCheck(
  ctx: GameContext,
  state: PokerState,
  index: number,
  config: PokerConfig,
): ReduceResult<PokerState> {
  const seat = state.seats[index]!;
  if (seat.streetBet < state.currentBet) throw new Error('You cannot check facing a bet');

  const next = markActed(state, seat.userId);
  return advance(next, ctx, index, config, [
    { type: 'poker:acted', payload: { userId: seat.userId, action: 'check' } },
  ]);
}

function applyCall(
  ctx: GameContext,
  state: PokerState,
  index: number,
  config: PokerConfig,
): ReduceResult<PokerState> {
  const seat = state.seats[index]!;
  const owed = state.currentBet - seat.streetBet;
  if (owed <= 0) throw new Error('There is nothing to call');

  const paid = Math.min(owed, seat.stack);
  const seats = replace(state.seats, index, commit(seat, paid));
  const next = markActed({ ...state, seats }, seat.userId);

  return advance(next, ctx, index, config, [
    { type: 'poker:acted', payload: { userId: seat.userId, action: 'call', amount: paid } },
  ]);
}

function applyRaise(
  ctx: GameContext,
  state: PokerState,
  index: number,
  target: number,
  config: PokerConfig,
): ReduceResult<PokerState> {
  const seat = state.seats[index]!;
  const problem = validateRaise(state, seat.userId, target);
  if (problem) throw new Error(problem);

  const paid = target - seat.streetBet;
  const seats = replace(state.seats, index, commit(seat, paid));

  // A raise that clears the current bet by at least the last full increment reopens the
  // action; one that does not (only possible all-in) raises the bet without doing so.
  const increment = target - state.currentBet;
  const fullRaise = increment >= state.minRaise;

  const next: PokerState = {
    ...state,
    seats,
    currentBet: target,
    minRaise: fullRaise ? increment : state.minRaise,
    actedThisStreet: [...new Set([...state.actedThisStreet, seat.userId])],
    actedSinceFullRaise: fullRaise
      ? [seat.userId]
      : [...new Set([...state.actedSinceFullRaise, seat.userId])],
  };

  return advance(next, ctx, index, config, [
    {
      type: 'poker:acted',
      payload: {
        userId: seat.userId,
        action: state.currentBet === 0 ? 'bet' : 'raise',
        amount: paid,
        to: target,
        allIn: seats[index]!.allIn,
      },
    },
  ]);
}

// --- flow ------------------------------------------------------------------

/**
 * Moves the hand on after an action: next player, next street, or the end.
 *
 * Every path out of a player's action goes through here, so there is one place where
 * "whose turn is it" and "is the hand over" are decided.
 */
function advance(
  state: PokerState,
  ctx: GameContext,
  fromIndex: number,
  config: PokerConfig,
  events: Array<{ type: string; payload?: Record<string, unknown>; onlyTo?: readonly string[] }>,
): ReduceResult<PokerState> {
  // Everyone folded but one: the hand ends without a showdown and without revealing.
  if (contenders(state).length <= 1) {
    return { ...finish(state, ctx, config, events), timer: null };
  }

  const next = nextToAct(state, fromIndex);
  if (next !== null) {
    return {
      state: { ...state, toActIndex: next, deadlineAt: ctx.now() + config.turnTimerMs },
      events: [...events, { type: 'poker:to_act', payload: { userId: state.seats[next]!.userId } }],
      timer: { id: TURN_TIMER_ID, delayMs: config.turnTimerMs },
    };
  }

  return nextStreet(state, ctx, config, events);
}

/** Deals the next street, or runs the board out when nobody can bet again. */
function nextStreet(
  state: PokerState,
  ctx: GameContext,
  config: PokerConfig,
  events: Array<{ type: string; payload?: Record<string, unknown>; onlyTo?: readonly string[] }>,
): ReduceResult<PokerState> {
  const streetIndex = STREETS.indexOf(state.street);
  if (streetIndex < 0 || state.street === 'river') {
    return { ...finish(state, ctx, config, events), timer: null };
  }

  let working: PokerState = {
    ...state,
    seats: state.seats.map((seat) => ({ ...seat, streetBet: 0 })),
    currentBet: 0,
    minRaise: state.bigBlind,
    actedThisStreet: [],
    actedSinceFullRaise: [],
  };

  const collected = [...events];
  let street = STREETS[streetIndex + 1]!;

  // With at most one player able to act, no more betting is possible: deal the rest of the
  // board in one go rather than pretending there are betting rounds left.
  const canStillBet = working.seats.filter(isLive).length > 1;

  for (;;) {
    const deal = street === 'flop' ? 3 : 1;
    working = {
      ...working,
      street,
      board: [...working.board, ...working.deck.slice(0, deal)],
      deck: working.deck.slice(deal),
    };
    collected.push({
      type: 'poker:board',
      payload: { street, board: cardNames(working.board) },
    });

    if (canStillBet || street === 'river') break;
    street = STREETS[STREETS.indexOf(street) + 1]!;
  }

  if (!canStillBet) return { ...finish(working, ctx, config, collected), timer: null };

  // After the flop, action starts to the button's left — heads-up included, which is why
  // the button acts last on every street but the first.
  const first = nextToAct(working, working.buttonIndex);
  if (first === null) return { ...finish(working, ctx, config, collected), timer: null };

  return {
    state: { ...working, toActIndex: first, deadlineAt: ctx.now() + config.turnTimerMs },
    events: [
      ...collected,
      { type: 'poker:to_act', payload: { userId: working.seats[first]!.userId } },
    ],
    timer: { id: TURN_TIMER_ID, delayMs: config.turnTimerMs },
  };
}

/** Builds the pots, awards them, and closes the hand. */
function finish(
  state: PokerState,
  ctx: GameContext,
  config: PokerConfig,
  events: Array<{ type: string; payload?: Record<string, unknown>; onlyTo?: readonly string[] }>,
): { state: PokerState; events: typeof events } {
  const live = contenders(state);
  const showdown = live.length > 1;

  const count = state.seats.length;
  const potPlayers: PotPlayer[] = state.seats.map((seat, index) => ({
    userId: seat.userId,
    committed: seat.committed,
    folded: seat.folded,
    allIn: seat.allIn,
    // Distance from the button's left, computed here rather than taken from the seat's
    // `order`. The odd chip of a split belongs to the first player left of the button
    // (§6.5), and that is a fact about the button's position — not about whatever order
    // the table happened to hand the seats over in.
    order: (index - state.buttonIndex - 1 + count) % count,
    // Only a hand that reaches a showdown is evaluated. Winning uncontested never shows
    // cards — the one rule everyone notices if you get it wrong.
    ...(showdown && !seat.folded ? { cards: seat.cards } : {}),
  }));

  const rake = rakeFor(state, config, showdown);
  const result = settleShowdown({ players: potPlayers, board: state.board, rake });

  const stacks: Record<string, number> = {};
  for (const seat of state.seats) stacks[seat.userId] = seat.stack;
  for (const award of [...result.awards, ...result.returned]) {
    stacks[award.userId] = (stacks[award.userId] ?? 0) + award.amount;
  }

  const winners = new Set(result.awards.map((a) => a.userId));
  const seats = state.seats.map((seat) => ({
    ...seat,
    stack: stacks[seat.userId] ?? seat.stack,
    // Shown at showdown only. A losing hand that was never called is not revealed, and a
    // player who mucks keeps their cards out of every view (the log still has them).
    revealed: showdown && !seat.folded && (winners.has(seat.userId) || !config.muckLosers),
  }));

  return {
    state: {
      ...state,
      street: 'complete',
      seats,
      toActIndex: null,
      deadlineAt: null,
      result: {
        pots: result.pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible })),
        awards: result.awards,
        returned: result.returned,
        rake: result.rake,
        stacks,
        shown: seats
          .filter((seat) => seat.revealed)
          .map((seat) => ({ userId: seat.userId, cards: cardNames(seat.cards) })),
      },
    },
    events: [
      ...events,
      {
        type: 'poker:showdown',
        payload: {
          pots: result.pots,
          awards: result.awards,
          returned: result.returned,
          rake: result.rake,
          shown: seats
            .filter((seat) => seat.revealed)
            .map((seat) => ({ userId: seat.userId, cards: cardNames(seat.cards) })),
        },
      },
    ],
  };
}

/**
 * Rake for this hand: a capped percentage of the pot.
 *
 * **No flop, no drop** — a hand that ends before the flop is never raked, which is the
 * standard cash-game rule and the one players check. Zero on `TST` by configuration.
 */
function rakeFor(state: PokerState, config: PokerConfig, showdown: boolean): number {
  if (config.rake.bps === 0) return 0;
  if (state.board.length === 0) return 0;
  if (!showdown && state.board.length === 0) return 0;

  const pot = state.seats.reduce((sum, seat) => sum + seat.committed, 0);
  return Math.min(Math.floor((pot * config.rake.bps) / 10_000), config.rake.cap);
}

// --- helpers ---------------------------------------------------------------

/** Opens the first betting round: preflop action starts left of the big blind. */
function openStreet(
  state: PokerState,
  ctx: GameContext,
  bbIndex: number,
  config: PokerConfig,
): PokerState {
  const first = nextToAct(state, bbIndex);
  return {
    ...state,
    toActIndex: first,
    deadlineAt: first === null ? null : ctx.now() + config.turnTimerMs,
  };
}

function post(seat: HandSeat, amount: number): HandSeat {
  return commit(seat, Math.min(amount, seat.stack));
}

function commit(seat: HandSeat, amount: number): HandSeat {
  const paid = Math.max(0, Math.min(amount, seat.stack));
  const stack = seat.stack - paid;
  return {
    ...seat,
    stack,
    committed: seat.committed + paid,
    streetBet: seat.streetBet + paid,
    allIn: stack === 0,
  };
}

function allInTarget(seat: HandSeat): number {
  return seat.streetBet + seat.stack;
}

function markActed(state: PokerState, userId: string): PokerState {
  return {
    ...state,
    actedThisStreet: [...new Set([...state.actedThisStreet, userId])],
    actedSinceFullRaise: [...new Set([...state.actedSinceFullRaise, userId])],
  };
}

function replace(seats: readonly HandSeat[], index: number, seat: HandSeat): HandSeat[] {
  const copy = [...seats];
  copy[index] = seat;
  return copy;
}

/** Everything anyone at the table may see. No hole cards except those shown down. */
function publicHand(state: PokerState): Record<string, unknown> {
  return {
    street: state.street,
    board: cardNames(state.board),
    pot: state.seats.reduce((sum, seat) => sum + seat.committed, 0),
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    blinds: state.blinds,
    buttonSeat: state.seats[state.buttonIndex]?.seat ?? null,
    toAct: state.toActIndex === null ? null : state.seats[state.toActIndex]!.userId,
    deadlineAt: state.deadlineAt,
    seats: state.seats.map((seat) => ({
      userId: seat.userId,
      seat: seat.seat,
      stack: seat.stack,
      committed: seat.committed,
      streetBet: seat.streetBet,
      folded: seat.folded,
      allIn: seat.allIn,
      // Cards appear here only once the hand has shown them down.
      cards: seat.revealed ? cardNames(seat.cards) : null,
    })),
    result: state.result,
  };
}

function seatMetaOf(player: GamePlayer): { seat: number; order: number; stack: number } {
  const meta = (player.meta ?? {}) as Record<string, unknown>;
  return {
    seat: Number(meta.seat ?? 0),
    order: Number(meta.order ?? 0),
    stack: Number(meta.stack ?? 0),
  };
}
