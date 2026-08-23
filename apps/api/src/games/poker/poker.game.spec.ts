import type { GameAction, GameContext, GamePlayer } from '@casino/contracts';
import { parseCard } from './cards';
import { poker, TURN_TIMER_ID, type PokerState } from './poker.game';

const T0 = 1_700_000_000_000;
const BB = 20;
const SB = 10;

const CONFIG = {
  blinds: { sb: SB, bb: BB },
  buyIn: { min: 400, max: 2_000 },
  turnTimerMs: 15_000,
  timebankMs: 30_000,
  timebankStepMs: 10_000,
  rake: { bps: 0, cap: 0 },
  buttonOrder: 0,
  muckLosers: true,
};

/** A table of `count` players, each with `stack`, in deal order. */
function seats(count: number, stack = 1_000): GamePlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `p${i}`,
    seat: i,
    stake: 0,
    meta: { seat: i, order: i, stack },
  }));
}

function makeCtx(players: GamePlayer[], options: { config?: object; deck?: number[] } = {}): GameContext {
  // A fixed deck makes hands reproducible. The shuffle draws are consumed in Fisher–Yates
  // order; returning 0 every time leaves the deck in its natural order reversed in a known
  // way, which is enough for structural tests. Card-specific tests stack the deck instead.
  let cursor = 0;
  const draws = options.deck ?? [];

  return {
    matchId: 'hand-1',
    players,
    config: { ...CONFIG, ...(options.config ?? {}) },
    random: (max: number) => {
      const value = draws[cursor++];
      return value === undefined ? 0 : value % max;
    },
    now: () => T0,
  };
}

function act(state: PokerState, ctx: GameContext, action: GameAction): PokerState {
  return poker.reduce(ctx, state, action).state;
}

const toAct = (state: PokerState) =>
  state.toActIndex === null ? null : state.seats[state.toActIndex]!.userId;

const stackOf = (state: PokerState, userId: string) =>
  state.seats.find((s) => s.userId === userId)!.stack;

describe('poker — dealing and blinds', () => {
  it('deals two cards to everyone and posts the blinds', () => {
    const players = seats(3);
    const state = poker.init(makeCtx(players));

    expect(state.seats).toHaveLength(3);
    expect(state.seats.every((s) => s.cards.length === 2)).toBe(true);

    // Every dealt card is distinct — the deck is not handing out the same card twice.
    const dealt = state.seats.flatMap((s) => s.cards);
    expect(new Set(dealt).size).toBe(6);

    // Three-handed: button p0, small blind p1, big blind p2.
    expect(stackOf(state, 'p1')).toBe(1_000 - SB);
    expect(stackOf(state, 'p2')).toBe(1_000 - BB);
    expect(state.currentBet).toBe(BB);
  });

  it('starts the action to the left of the big blind', () => {
    const state = poker.init(makeCtx(seats(3)));
    expect(toAct(state)).toBe('p0'); // button acts first three-handed, preflop
  });

  it('puts the button on the small blind heads-up, acting first before the flop', () => {
    const state = poker.init(makeCtx(seats(2)));

    expect(stackOf(state, 'p0')).toBe(1_000 - SB); // button posts the small blind
    expect(stackOf(state, 'p1')).toBe(1_000 - BB);
    expect(toAct(state)).toBe('p0');
  });

  it('refuses an action from someone not in the hand, and out of turn', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    expect(() => act(state, ctx, { type: 'fold', userId: 'stranger' })).toThrow(/not in this hand/i);
    expect(() => act(state, ctx, { type: 'fold', userId: 'p1' })).toThrow(/not your turn/i);
    expect(() => act(state, ctx, { type: 'nonsense', userId: 'p0' })).toThrow(/unknown action/i);
  });

  it('ignores a seat named in the payload — identity comes from the action', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    // p0 is to act. Claiming to be p1 in the payload changes nothing: the reducer reads
    // `action.userId`, which the engine takes from the authenticated session.
    const after = act(state, ctx, { type: 'fold', userId: 'p0', payload: { seat: 1, userId: 'p1' } });
    expect(after.seats.find((s) => s.userId === 'p0')!.folded).toBe(true);
    expect(after.seats.find((s) => s.userId === 'p1')!.folded).toBe(false);
  });
});

describe('poker — the button, for every table size', () => {
  /**
   * The table hands seats over in deal order — the button's left first, button last — so
   * `buttonOrder` is the last index. These assertions pin that convention, because getting
   * it wrong puts the blinds on the wrong players and hands the odd chip of a split to the
   * wrong one, both of which are quiet, expensive bugs.
   */
  function tableOf(count: number) {
    const players = seats(count);
    const ctx = makeCtx(players, { config: { buttonOrder: count - 1 } });
    return { state: poker.init(ctx), ctx, players };
  }

  it.each([3, 4, 5, 6])('posts the blinds left of the button (%i-handed)', (count) => {
    const { state } = tableOf(count);

    // Button is last in deal order, so the small blind is index 0 and the big blind is 1.
    expect(stackOf(state, 'p0')).toBe(1_000 - SB);
    expect(stackOf(state, 'p1')).toBe(1_000 - BB);
    expect(stackOf(state, `p${count - 1}`)).toBe(1_000);
  });

  it.each([3, 4, 5, 6])('starts preflop action left of the big blind (%i-handed)', (count) => {
    const { state } = tableOf(count);
    // Three-handed that wraps back to the button; with more players it is the next seat.
    expect(toAct(state)).toBe(count === 3 ? 'p2' : 'p2');
  });

  it('acts from the small blind after the flop, with the button last', () => {
    const { state, ctx } = tableOf(4);
    let hand = state;

    hand = act(hand, ctx, { type: 'call', userId: 'p2' });
    hand = act(hand, ctx, { type: 'call', userId: 'p3' }); // the button
    hand = act(hand, ctx, { type: 'call', userId: 'p0' }); // small blind completes
    hand = act(hand, ctx, { type: 'check', userId: 'p1' }); // big blind's option

    expect(hand.street).toBe('flop');
    expect(toAct(hand)).toBe('p0');
  });
});

describe('poker — betting rules', () => {
  it('gives the big blind its option when everyone limps', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'call', userId: 'p0' }); // button limps
    state = act(state, ctx, { type: 'call', userId: 'p1' }); // small blind completes

    // Everyone has matched the big blind — but the big blind has not acted, so the street
    // is not over. This is the case a naive "all bets equal" check gets wrong.
    expect(state.street).toBe('preflop');
    expect(toAct(state)).toBe('p2');

    state = act(state, ctx, { type: 'check', userId: 'p2' });
    expect(state.street).toBe('flop');
  });

  it('refuses a check when facing a bet', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);
    expect(() => act(state, ctx, { type: 'check', userId: 'p0' })).toThrow(/facing a bet/i);
  });

  it('enforces the minimum raise', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    // Facing the big blind of 20, the minimum raise is to 40.
    expect(() => act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 30 } })).toThrow(
      /minimum raise is to 40/i,
    );
    expect(act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 40 } }).currentBet).toBe(40);
  });

  it('grows the minimum raise by the last full increment', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 60 } }); // +40
    // The next raise must be at least another 40, i.e. to 100.
    expect(() => act(state, ctx, { type: 'raise', userId: 'p1', payload: { amount: 90 } })).toThrow(
      /minimum raise is to 100/i,
    );
    expect(act(state, ctx, { type: 'raise', userId: 'p1', payload: { amount: 100 } }).currentBet).toBe(100);
  });

  it('refuses a raise beyond the stack, and rejects fractional chips', () => {
    const players = seats(3, 100);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    expect(() => act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 500 } })).toThrow(
      /do not have that many chips/i,
    );
    expect(() => act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 40.5 } })).toThrow(
      /whole chips/i,
    );
  });

  it('does NOT reopen the action for an all-in below a full raise', () => {
    // p0 raises to 100. p1 is all-in for 130 — only +30 on a required +80. p2 calls.
    // p0 may now call or fold, but must not be allowed to raise again.
    const players = [
      { userId: 'p0', seat: 0, stake: 0, meta: { seat: 0, order: 0, stack: 1_000 } },
      { userId: 'p1', seat: 1, stake: 0, meta: { seat: 1, order: 1, stack: 130 } },
      { userId: 'p2', seat: 2, stake: 0, meta: { seat: 2, order: 2, stack: 1_000 } },
    ];
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 100 } });
    state = act(state, ctx, { type: 'allIn', userId: 'p1' });

    expect(state.currentBet).toBe(130);
    expect(state.seats.find((s) => s.userId === 'p1')!.allIn).toBe(true);

    state = act(state, ctx, { type: 'call', userId: 'p2' });
    expect(toAct(state)).toBe('p0');

    expect(() => act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 300 } })).toThrow(
      /does not reopen/i,
    );
    // …but calling is fine.
    state = act(state, ctx, { type: 'call', userId: 'p0' });
    expect(state.street).toBe('flop');
  });

  it('DOES reopen the action for a full all-in raise', () => {
    const players = [
      { userId: 'p0', seat: 0, stake: 0, meta: { seat: 0, order: 0, stack: 1_000 } },
      { userId: 'p1', seat: 1, stake: 0, meta: { seat: 1, order: 1, stack: 400 } },
      { userId: 'p2', seat: 2, stake: 0, meta: { seat: 2, order: 2, stack: 1_000 } },
    ];
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 100 } });
    state = act(state, ctx, { type: 'allIn', userId: 'p1' }); // to 400: a full raise
    state = act(state, ctx, { type: 'call', userId: 'p2' });

    expect(toAct(state)).toBe('p0');
    // A full raise reopened the action, so p0 may raise again.
    const raised = act(state, ctx, { type: 'raise', userId: 'p0', payload: { amount: 800 } });
    expect(raised.currentBet).toBe(800);
  });

  it('lets a short stack go all-in below the minimum', () => {
    const players = [
      { userId: 'p0', seat: 0, stake: 0, meta: { seat: 0, order: 0, stack: 25 } },
      { userId: 'p1', seat: 1, stake: 0, meta: { seat: 1, order: 1, stack: 1_000 } },
      { userId: 'p2', seat: 2, stake: 0, meta: { seat: 2, order: 2, stack: 1_000 } },
    ];
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    const allIn = act(state, ctx, { type: 'allIn', userId: 'p0' });
    expect(allIn.seats.find((s) => s.userId === 'p0')!.allIn).toBe(true);
    expect(allIn.currentBet).toBe(25);
  });
});

describe('poker — a hand from deal to showdown', () => {
  it('runs four streets and ends with a result', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    // Preflop: everyone limps, big blind checks.
    state = act(state, ctx, { type: 'call', userId: 'p0' });
    state = act(state, ctx, { type: 'call', userId: 'p1' });
    state = act(state, ctx, { type: 'check', userId: 'p2' });
    expect(state.street).toBe('flop');
    expect(state.board).toHaveLength(3);

    // Postflop the small blind acts first.
    for (const street of ['turn', 'river'] as const) {
      state = act(state, ctx, { type: 'check', userId: 'p1' });
      state = act(state, ctx, { type: 'check', userId: 'p2' });
      state = act(state, ctx, { type: 'check', userId: 'p0' });
      expect(state.street).toBe(street);
    }

    state = act(state, ctx, { type: 'check', userId: 'p1' });
    state = act(state, ctx, { type: 'check', userId: 'p2' });
    state = act(state, ctx, { type: 'check', userId: 'p0' });

    expect(state.street).toBe('complete');
    expect(poker.isTerminal(state)).toBe(true);
    expect(state.board).toHaveLength(5);
    expect(state.result).not.toBeNull();

    // Chips are conserved: the table has exactly what it started with.
    const total = state.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(total + state.result!.rake).toBe(3_000);
  });

  it('ends without a showdown when everyone folds, and reveals nothing', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'fold', userId: 'p0' });
    state = act(state, ctx, { type: 'fold', userId: 'p1' });

    expect(state.street).toBe('complete');
    expect(state.result!.shown).toEqual([]);
    expect(state.seats.every((s) => !s.revealed)).toBe(true);

    // The big blind takes the small blind's chips and gets its own back.
    expect(stackOf(state, 'p2')).toBe(1_000 + SB);
  });

  it('runs the board out when everyone is all-in', () => {
    const players = seats(2, 100);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'allIn', userId: 'p0' });
    state = act(state, ctx, { type: 'call', userId: 'p1' });

    expect(state.street).toBe('complete');
    expect(state.board).toHaveLength(5);
    // One of them has all 200 chips.
    expect(state.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(200);
  });
});

describe('poker — timers', () => {
  it('spends timebank before acting for a player', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    const first = poker.onTimeout(ctx, state, TURN_TIMER_ID);
    expect(first.state.timebank.p0).toBe(20_000);
    expect(first.state.seats.find((s) => s.userId === 'p0')!.folded).toBe(false);
    expect(first.timer).toEqual({ id: TURN_TIMER_ID, delayMs: 10_000 });
  });

  it('folds a player facing a bet once the timebank is gone', () => {
    const players = seats(3);
    const ctx = makeCtx(players, { config: { timebankMs: 0 } });
    const state = poker.init(ctx);

    const result = poker.onTimeout(ctx, state, TURN_TIMER_ID);
    expect(result.state.seats.find((s) => s.userId === 'p0')!.folded).toBe(true);
    expect(result.events[0]!.type).toBe('poker:auto_action');
  });

  it('checks rather than folds when checking is free', () => {
    const players = seats(3);
    const ctx = makeCtx(players, { config: { timebankMs: 0 } });
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'call', userId: 'p0' });
    state = act(state, ctx, { type: 'call', userId: 'p1' });
    // p2 (big blind) can check for free — the server must never fold a free option.
    const result = poker.onTimeout(ctx, state, TURN_TIMER_ID);

    expect(result.state.seats.find((s) => s.userId === 'p2')!.folded).toBe(false);
    expect(result.state.street).toBe('flop');
  });

  it('re-arms the remaining turn time after a restart', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    const later: GameContext = { ...ctx, now: () => T0 + 5_000 };
    expect(poker.pendingTimer!(later, state)).toEqual({ id: TURN_TIMER_ID, delayMs: 10_000 });

    const finished = { ...state, street: 'complete' as const };
    expect(poker.pendingTimer!(ctx, finished)).toBeNull();
  });
});

describe('poker — information hiding', () => {
  it('shows a player their own cards and nobody else’s', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    const view = poker.playerView(ctx, state, 'p0') as Record<string, unknown>;
    const you = view.you as { cards: string[] };
    expect(you.cards).toHaveLength(2);

    const otherSeats = (view.seats as Array<{ userId: string; cards: unknown }>).filter(
      (s) => s.userId !== 'p0',
    );
    expect(otherSeats.every((s) => s.cards === null)).toBe(true);
  });

  it('never puts the deck in any view', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);

    for (const view of [
      poker.playerView(ctx, state, 'p0'),
      poker.playerView(ctx, state, 'p1'),
      poker.publicView!(ctx, state),
    ]) {
      expect(Object.keys(view)).not.toContain('deck');
      expect(JSON.stringify(view)).not.toContain('"deck"');
    }
  });

  it('keeps every other hand out of a player’s view for the whole hand', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    const secretsOf = (userId: string) =>
      state.seats.find((s) => s.userId === userId)!.cards.map(String);

    const script: GameAction[] = [
      { type: 'call', userId: 'p0' },
      { type: 'call', userId: 'p1' },
      { type: 'check', userId: 'p2' },
      { type: 'check', userId: 'p1' },
      { type: 'check', userId: 'p2' },
      { type: 'check', userId: 'p0' },
    ];

    for (const action of script) {
      state = act(state, ctx, action);
      const view = JSON.stringify(poker.playerView(ctx, state, 'p0'));
      // p1's and p2's actual card integers must not appear anywhere in p0's view while
      // the hand is live.
      for (const other of ['p1', 'p2']) {
        for (const card of secretsOf(other)) {
          const name = cardNameOf(Number(card));
          expect(view).not.toContain(`"${name}"`);
        }
      }
    }
  });

  it('gives a spectator the board and stacks but nobody’s hand', () => {
    const players = seats(3);
    const ctx = makeCtx(players);
    const state = poker.init(ctx);
    const view = poker.publicView!(ctx, state) as Record<string, unknown>;

    expect(view.you).toBeUndefined();
    expect((view.seats as Array<{ cards: unknown }>).every((s) => s.cards === null)).toBe(true);
  });

  it('reveals only at showdown, and only hands that were shown down', () => {
    const players = seats(2);
    const ctx = makeCtx(players);
    let state = poker.init(ctx);

    state = act(state, ctx, { type: 'fold', userId: 'p0' });
    expect(state.street).toBe('complete');

    const view = poker.publicView!(ctx, state) as Record<string, unknown>;
    expect((view.seats as Array<{ cards: unknown }>).every((s) => s.cards === null)).toBe(true);
  });
});

function cardNameOf(card: number): string {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const suits = ['c', 'd', 'h', 's'];
  return `${ranks[Math.floor(card / 4)]}${suits[card % 4]}`;
}

/** Unused re-export guard: keeps `parseCard` imported for future card-specific tests. */
void parseCard;
