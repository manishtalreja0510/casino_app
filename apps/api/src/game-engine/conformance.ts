import type { GameContext, GameDefinition, GamePlayer } from '@casino/contracts';

/**
 * The conformance suite every game must pass (ADR-009).
 *
 * These are the guarantees the engine relies on. A game that fails any of them will
 * misbehave in ways that are expensive to find later — a non-deterministic reducer breaks
 * crash recovery, a leaky `playerView` hands one player another's hidden cards, and a
 * settlement that does not sum to the pot creates or destroys money.
 *
 * Exported as a plain function so P8 and P9 call it from their own test files with their
 * own scenarios.
 */

export interface ConformanceScenario {
  /** Players to seat, with stakes. */
  players: GamePlayer[];
  config?: Record<string, unknown>;
  /** Actions that drive a match from start to a terminal state. */
  script: Array<{ type: string; userId: string; payload?: Record<string, unknown> }>;
  /** Keys of `playerView` output that must never appear for a non-owner. */
  secretViewKeys?: string[];
  /**
   * Clock reads handed to the reducer, in order, then held at the last value.
   *
   * A game whose outcome depends on elapsed time cannot be scripted with a frozen clock —
   * every cash-out would be priced at lift-off. Supplied per scenario and reused
   * identically across runs, so the determinism check still means what it says.
   */
  clock?: number[];
  /**
   * A timer to fire after the script, before checking for a terminal state.
   *
   * Round games end on a deadline rather than on a move: without this, their scripted
   * match would correctly never terminate and the suite would report it as a failure.
   */
  finalTimerId?: string;
}

export interface ConformanceFinding {
  check: string;
  detail: string;
}

export function runConformance<TState>(
  definition: GameDefinition<TState>,
  scenario: ConformanceScenario,
): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const record = (check: string, detail: string) => findings.push({ check, detail });

  const makeCtx = (draws: number[], cursor = { i: 0 }, clockCursor = { i: 0 }): GameContext => ({
    matchId: 'conformance-match',
    players: scenario.players,
    config: scenario.config ?? {},
    random: (max: number) => {
      const value = draws[cursor.i++] ?? 0;
      return value % max;
    },
    now: () => {
      const reads = scenario.clock;
      if (!reads || reads.length === 0) return 1_700_000_000_000;
      const value = reads[Math.min(clockCursor.i, reads.length - 1)]!;
      clockCursor.i++;
      return value;
    },
  });

  // --- metadata sanity -----------------------------------------------------
  const { meta } = definition;
  if (!meta.code || !/^[a-z0-9-]+$/.test(meta.code)) {
    record('meta.code', 'must be a lowercase kebab-case identifier');
  }
  if (meta.minPlayers < 1 || meta.maxPlayers < meta.minPlayers) {
    record('meta.players', `invalid range ${meta.minPlayers}-${meta.maxPlayers}`);
  }
  if (meta.version < 1) record('meta.version', 'versions start at 1');

  // --- determinism ---------------------------------------------------------
  // The same inputs and the same draws must produce the same state, or replay-based
  // recovery silently produces a different match than the one that was played.
  const draws = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 11);
  const first = playScript(definition, scenario, makeCtx(draws));
  const second = playScript(definition, scenario, makeCtx(draws));

  if (JSON.stringify(first.state) !== JSON.stringify(second.state)) {
    record('determinism', 'the same actions and RNG draws produced different states');
  }

  // --- purity --------------------------------------------------------------
  // `reduce` must not mutate the state it is handed; the engine keeps prior state for
  // snapshots and replay.
  const ctx = makeCtx(draws);
  const state = definition.init(ctx);
  const snapshot = JSON.stringify(state);
  const firstAction = scenario.script[0];
  if (firstAction) {
    try {
      definition.reduce(ctx, state, firstAction);
      if (JSON.stringify(state) !== snapshot) {
        record('purity', 'reduce mutated the state it was given');
      }
    } catch {
      record('script', 'the first scripted action was rejected by reduce');
    }
  }

  // --- information hiding --------------------------------------------------
  // The single most important guarantee: a player's view must not contain another
  // player's secrets while they are still secret (rule 2). Poker's hole cards are exactly
  // this case.
  //
  // Checked at every NON-TERMINAL step, because revealing at showdown is legitimate — a
  // game that never revealed anything could not be played. What must never happen is a
  // secret appearing in someone else's view before the game discloses it.
  const secretKeys = scenario.secretViewKeys ?? [];
  if (secretKeys.length > 0) {
    const assertHidden = (stateToCheck: TState): void => {
      for (const viewer of scenario.players) {
        const view = definition.playerView(makeCtx(draws), stateToCheck, viewer.userId);

        for (const key of secretKeys) {
          const exposed = (view as Record<string, unknown>)[key];
          if (exposed === null || typeof exposed !== 'object') continue;

          for (const other of scenario.players) {
            if (other.userId === viewer.userId) continue;
            if (Object.prototype.hasOwnProperty.call(exposed, other.userId)) {
              record(
                'information-hiding',
                `${viewer.userId}'s view exposes "${key}" for ${other.userId} before it is revealed`,
              );
            }
          }
        }
      }
    };

    let midState = definition.init(makeCtx(draws));
    assertHidden(midState);

    for (const action of scenario.script) {
      if (definition.isTerminal(midState)) break;
      try {
        midState = definition.reduce(makeCtx(draws), midState, action).state;
      } catch {
        break;
      }
      // Checked AFTER each move as well as before: a leak introduced by the last
      // scripted action would otherwise never be looked at.
      if (!definition.isTerminal(midState)) assertHidden(midState);
    }
  }

  const played = playScript(definition, scenario, makeCtx(draws));

  // --- rejection of invalid actions ---------------------------------------
  const rejectCtx = makeCtx(draws);
  const freshState = definition.init(rejectCtx);
  try {
    definition.reduce(rejectCtx, freshState, {
      type: '__definitely_not_a_real_action__',
      userId: scenario.players[0]!.userId,
    });
    record('validation', 'an unknown action type was accepted');
  } catch {
    // Expected.
  }

  try {
    definition.reduce(rejectCtx, freshState, {
      type: scenario.script[0]?.type ?? 'noop',
      userId: 'not-a-participant',
    });
    record('validation', 'an action from a non-participant was accepted');
  } catch {
    // Expected.
  }

  // --- terminal state and settlement --------------------------------------
  if (!definition.isTerminal(played.state)) {
    record('terminal', 'the scripted match did not reach a terminal state');
  } else {
    const pot = scenario.players.reduce((sum, player) => sum + player.stake, 0);
    const payouts = definition.settle(makeCtx(draws), played.state);
    const total = payouts.reduce((sum, payout) => sum + payout.amount, 0);

    if (payouts.some((payout) => !Number.isSafeInteger(payout.amount) || payout.amount < 0)) {
      record('settlement', 'payouts must be non-negative integers in minor units');
    }

    // What "too much" means depends on who is paying (ADR-024).
    //
    // A pooled game pays players out of each other's stakes, so exceeding the pot would
    // create money. A house-banked game is *expected* to exceed it — that is what winning
    // against the house means — but it must still be bounded, and the bound is the payout
    // multiple the game itself declares. A house-banked game with no declared bound is the
    // failure: unbounded house liability is not something to discover in production.
    const banking = meta.banking ?? 'pooled';
    if (banking === 'table') {
      // A table-banked game keeps chips as state inside an escrow that outlives the match,
      // so it must not pay anyone out at settlement — and it must be able to say what the
      // house takes, since that is the only money that moves (ADR-025).
      if (total !== 0) {
        record('settlement', 'a table-banked game must not return payouts; chips are state');
      }
      if (typeof definition.rakeFor !== 'function') {
        record('settlement', 'a table-banked game must implement rakeFor');
      }
    } else if (banking === 'pooled') {
      if (total > pot) {
        record('settlement', `payouts total ${total}, which exceeds the pot of ${pot}`);
      }
    } else if (meta.maxPayoutX100 === undefined) {
      record('settlement', 'a house-banked game must declare meta.maxPayoutX100');
    } else {
      const ceiling = Math.floor((pot * meta.maxPayoutX100) / 100);
      if (total > ceiling) {
        record(
          'settlement',
          `payouts total ${total}, above the declared ceiling of ${ceiling} (${meta.maxPayoutX100 / 100}x)`,
        );
      }
    }

    const unknown = payouts.find(
      (payout) => !scenario.players.some((player) => player.userId === payout.userId),
    );
    if (unknown) record('settlement', `payout to ${unknown.userId}, who is not in the match`);
  }

  return findings;
}

function playScript<TState>(
  definition: GameDefinition<TState>,
  scenario: ConformanceScenario,
  ctx: GameContext,
): { state: TState } {
  let state = definition.init(ctx);
  for (const action of scenario.script) {
    if (definition.isTerminal(state)) break;
    try {
      state = definition.reduce(ctx, state, action).state;
    } catch {
      // A scripted action may legitimately become invalid once the match ends.
    }
  }

  // Round games end on a deadline, not on a move.
  if (scenario.finalTimerId && !definition.isTerminal(state)) {
    try {
      state = definition.onTimeout(ctx, state, scenario.finalTimerId).state;
    } catch {
      // Reported by the terminal check below rather than swallowed silently.
    }
  }
  return { state };
}
