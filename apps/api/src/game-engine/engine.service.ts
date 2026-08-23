import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  GameAction,
  GameContext,
  GameDefinition,
  GamePlayer,
  MatchStatus,
  ReduceResult,
} from '@casino/contracts';
import { PG_POOL } from '../platform/database/database.module';
import { withTransaction } from '../platform/database/transaction';
import { AuditService } from '../platform/audit/audit.service';
import { canonicalStringify } from '../platform/serialization/canonical-json';
import { FlagsService } from '../platform/flags/flags.service';
import { gameEnabledKey } from '../platform/flags/flag-keys';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimerService } from '../realtime/timer.service';
import { Rooms } from '../realtime/realtime.types';
import { GameRegistry } from './game.registry';
import { MatchRepository, type MatchRow } from './match.repository';
import { RngService, type RngDraw } from './rng.service';
import { ClockService } from './clock.service';
import {
  GameDisabledError,
  InvalidActionError,
  MatchNotFoundError,
  MatchNotPlayableError,
  NotAParticipantError,
} from './engine.errors';

/** How many events between snapshots. Bounds replay cost without making snapshots the truth. */
const SNAPSHOT_INTERVAL = 25;

/** What a match-change listener is told. Deliberately thin — listeners re-read what they need. */
export interface MatchChange {
  matchId: string;
  gameCode: string;
  status: MatchStatus;
}

/**
 * The engine (ADR-006, ADR-009).
 *
 * It owns everything a game must not have to think about: lifecycle, authorisation,
 * durable history, recovery, randomness, timers, and settlement. A game is a pure
 * reducer; every side effect happens here, in a single database transaction per action.
 */
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);
  private readonly changeListeners: Array<(change: MatchChange) => void | Promise<void>> = [];

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly registry: GameRegistry,
    private readonly matches: MatchRepository,
    private readonly rng: RngService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
    private readonly timers: TimerService,
    private readonly audit: AuditService,
    private readonly flags: FlagsService,
  ) {}

  /**
   * Creates a match and takes every player's buy-in into escrow.
   *
   * Buy-ins happen inside the creating transaction: a match must not exist unless the
   * money backing it does, or the engine could later settle stakes nobody paid.
   */
  async createMatch(input: {
    gameCode: string;
    players: { userId: string }[];
    stake: number;
    config?: Record<string, unknown>;
  }): Promise<{ matchId: string }> {
    const definition = this.registry.latest(input.gameCode);

    // Per-game kill-switch (rule 16). Checked before any money moves, and fail-closed:
    // a game whose flag cannot be read is unavailable rather than assumed playable.
    // Matches already in flight are unaffected — the switch stops new ones, so pulling it
    // never strands players mid-hand with their stakes in escrow.
    if (!(await this.flags.isEnabled(gameEnabledKey(definition.meta.code)))) {
      throw new GameDisabledError(definition.meta.code);
    }

    if (input.players.length < definition.meta.minPlayers || input.players.length > definition.meta.maxPlayers) {
      throw new InvalidActionError(
        `${definition.meta.code} needs ${definition.meta.minPlayers}-${definition.meta.maxPlayers} players`,
      );
    }

    // The match record and EVERY player's buy-in commit together.
    //
    // Charging players one transaction at a time would leave the first player paid for a
    // match that never started as soon as the second could not afford it — the worst
    // failure matchmaking can produce, and invisible until someone checks their balance.
    const matchId = await withTransaction(this.pool, async (client) => {
      const id = await this.matches.createMatch(client, {
        gameCode: definition.meta.code,
        gameVersion: definition.meta.version,
        stake: input.stake,
        currency: 'TST',
        config: input.config ?? {},
        players: input.players.map((player, index) => ({
          userId: player.userId,
          seat: index,
          stake: input.stake,
        })),
      });

      if (input.stake > 0) {
        for (const player of input.players) {
          // Throws on insufficient funds, rolling back the match and any earlier buy-in.
          await this.wallet.buyIn(
            { userId: player.userId, matchId: id, amount: input.stake },
            client,
          );
        }
      }

      return id;
    });

    await this.start(matchId);
    return { matchId };
  }

  /**
   * Opens a match nobody has joined yet (ADR-023).
   *
   * Round games need a match to escrow into *before* they know who is playing: the
   * betting window is the roster. Only games that declare `mode: 'rounds'` may be opened
   * this way — an empty matchmade match would be a bug that silently produced a game with
   * no players.
   */
  async createOpenMatch(input: {
    gameCode: string;
    stake: number;
    config?: Record<string, unknown>;
  }): Promise<{ matchId: string }> {
    const definition = this.registry.latest(input.gameCode);
    if (definition.meta.mode !== 'rounds') {
      throw new InvalidActionError(`${definition.meta.code} is not a round-based game`);
    }
    if (!(await this.flags.isEnabled(gameEnabledKey(definition.meta.code)))) {
      throw new GameDisabledError(definition.meta.code);
    }

    const matchId = await withTransaction(this.pool, (client) =>
      this.matches.createMatch(client, {
        gameCode: definition.meta.code,
        gameVersion: definition.meta.version,
        stake: input.stake,
        currency: 'TST',
        config: input.config ?? {},
        players: [],
      }),
    );
    return { matchId };
  }

  /**
   * Seats one player in an open match and takes their buy-in.
   *
   * Deliberately **not** all-or-nothing across players — that is the whole difference
   * from `createMatch`. In a duel, one player who cannot pay means there is no game; in a
   * round, it means one fewer better, and cancelling everyone else's bet because of it
   * would be the bug, not the safeguard.
   *
   * The match row is locked for the join, so seat numbers and the capacity check cannot
   * race. The buy-in shares this transaction: a seated player who was never charged, or a
   * charge with no seat, are both impossible.
   */
  async joinMatch(input: {
    matchId: string;
    userId: string;
    stake: number;
    meta?: Record<string, unknown>;
    /**
     * A last check the caller runs against the roster **inside the lock**.
     *
     * Round-level limits — total staked, house exposure, seat rules — depend on who has
     * already joined, and checking them before the transaction is a race: two bets read
     * the same total and both look affordable. Throwing here rejects the join with
     * nothing committed.
     */
    guard?: (players: readonly GamePlayer[]) => void;
  }): Promise<{ seat: number }> {
    return withTransaction(this.pool, async (client) => {
      const match = await this.matches.lockMatch(client, input.matchId);
      if (!match) throw new MatchNotFoundError();
      if (match.status !== 'created') throw new MatchNotPlayableError(match.status);

      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const players = await this.matches.listPlayers(input.matchId, client);

      if (players.some((player) => player.userId === input.userId)) {
        throw new InvalidActionError('You have already joined this round');
      }
      if (players.length >= definition.meta.maxPlayers) {
        throw new InvalidActionError('This round is full');
      }

      input.guard?.(players);

      const seat = players.length;
      await this.matches.addPlayer(client, {
        matchId: input.matchId,
        userId: input.userId,
        seat,
        stake: input.stake,
        meta: input.meta ?? {},
      });

      if (input.stake > 0) {
        await this.wallet.buyIn(
          { userId: input.userId, matchId: input.matchId, amount: input.stake },
          client,
        );
      }

      return { seat };
    });
  }

  /**
   * Starts an open match once its window closes.
   *
   * Returns `started: false` rather than throwing when too few players joined: an empty
   * betting window is an ordinary outcome of a round game, not an error, and the caller
   * needs to void the round and open the next one.
   */
  async startMatch(matchId: string): Promise<{ started: boolean; players: number }> {
    const match = await this.matches.findMatch(matchId);
    if (!match) throw new MatchNotFoundError();
    if (match.status !== 'created') return { started: false, players: 0 };

    const definition = this.registry.get(match.gameCode, match.gameVersion);
    const players = await this.matches.listPlayers(matchId);
    if (players.length < definition.meta.minPlayers) {
      return { started: false, players: players.length };
    }

    await this.start(matchId);
    return { started: true, players: players.length };
  }

  /** Initialises game state and moves the match to `in_progress`. */
  private async start(matchId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const match = await this.matches.lockMatch(client, matchId);
      if (!match) throw new MatchNotFoundError();
      if (match.status !== 'created') return;

      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const players = await this.matches.listPlayers(matchId, client);
      const recorder = this.rng.createRecorder();
      const clock = this.clock.createRecorder();
      const ctx = EngineService.context(match, players, recorder.random, clock.now);

      const state = definition.init(ctx);

      await this.matches.setStatus(client, matchId, 'in_progress');
      await this.matches.appendEvent(client, {
        matchId,
        seq: 1,
        type: 'match:init',
        payload: { state: state as Record<string, unknown> },
        draws: recorder.draws,
        clock: clock.reads,
      });
      await this.matches.saveSnapshot(client, matchId, 1, state);
    });

    // A game whose clock runs on its own (Crash in flight) has no move to carry its first
    // deadline; without this it would start and then never end.
    await this.armPendingTimer(matchId);
    await this.broadcastState(matchId);
    await this.notifyChanged(matchId);
  }

  /**
   * Applies a player action.
   *
   * Everything the client sends is treated as a request, not an instruction: participation
   * is checked against the roster, the match must be playable, and the reducer validates
   * the action itself. A rejected action mutates nothing and is not persisted (rule 1).
   */
  async submitAction(matchId: string, action: GameAction): Promise<void> {
    const result = await withTransaction(this.pool, async (client) => {
      const match = await this.matches.lockMatch(client, matchId);
      if (!match) throw new MatchNotFoundError();
      if (match.status !== 'in_progress') throw new MatchNotPlayableError(match.status);

      const players = await this.matches.listPlayers(matchId, client);
      if (!players.some((player) => player.userId === action.userId)) {
        throw new NotAParticipantError();
      }

      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const state = await this.rebuildState(match, players, definition, client);

      const recorder = this.rng.createRecorder();
      const clock = this.clock.createRecorder();
      const ctx = EngineService.context(match, players, recorder.random, clock.now);

      let reduced: ReduceResult<never>;
      try {
        reduced = definition.reduce(ctx, state as never, action);
      } catch (error) {
        // A reducer rejecting an action is normal control flow, not a server fault.
        throw new InvalidActionError(error instanceof Error ? error.message : 'Invalid action');
      }

      const seq = await this.matches.nextSeq(client, matchId);
      await this.matches.appendEvent(client, {
        matchId,
        seq,
        type: 'match:action',
        payload: {
          action: { type: action.type, userId: action.userId, payload: action.payload ?? {} },
          state: reduced.state as Record<string, unknown>,
          events: reduced.events,
        },
        actorId: action.userId,
        draws: recorder.draws,
        clock: clock.reads,
      });

      if (seq % SNAPSHOT_INTERVAL === 0) {
        await this.matches.saveSnapshot(client, matchId, seq, reduced.state);
      }

      const terminal = definition.isTerminal(reduced.state as never);
      if (terminal) await this.matches.setStatus(client, matchId, 'settling');

      return { match, players, definition, reduced, terminal, seq };
    });

    await this.applyTimer(matchId, result.reduced);
    // Events first, then the state snapshot. Events say what happened; `game:state` is the
    // full authoritative view, so applying it last means the last thing a client holds is
    // the truth rather than an inference from a notification.
    await this.deliverEvents(matchId, result.reduced, result.players, result.seq);
    await this.broadcastState(matchId);
    await this.notifyChanged(matchId);
    if (result.terminal) await this.settle(matchId);
  }

  /** A server-side deadline expired. The server decides what happens, never the client. */
  async handleTimeout(matchId: string, timerId: string): Promise<void> {
    const result = await withTransaction(this.pool, async (client) => {
      const match = await this.matches.lockMatch(client, matchId);
      if (!match || match.status !== 'in_progress') return null;

      const players = await this.matches.listPlayers(matchId, client);
      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const state = await this.rebuildState(match, players, definition, client);

      const recorder = this.rng.createRecorder();
      const clock = this.clock.createRecorder();
      const ctx = EngineService.context(match, players, recorder.random, clock.now);
      const reduced = definition.onTimeout(ctx, state as never, timerId);

      const seq = await this.matches.nextSeq(client, matchId);
      await this.matches.appendEvent(client, {
        matchId,
        seq,
        type: 'match:timeout',
        payload: {
          timerId,
          state: reduced.state as Record<string, unknown>,
          events: reduced.events,
        },
        draws: recorder.draws,
        clock: clock.reads,
      });

      const terminal = definition.isTerminal(reduced.state as never);
      if (terminal) await this.matches.setStatus(client, matchId, 'settling');
      return { reduced, terminal, players, seq };
    });

    if (!result) return;
    await this.applyTimer(matchId, result.reduced);
    await this.deliverEvents(matchId, result.reduced, result.players, result.seq);
    await this.broadcastState(matchId);
    await this.notifyChanged(matchId);
    if (result.terminal) await this.settle(matchId);
  }

  /**
   * Settles a terminal match.
   *
   * The engine computes payouts from game state and hands them to the wallet — it never
   * posts ledger entries itself (rule 10). Settlement is idempotent by match id, so a
   * retry after a crash pays once (proven in P4).
   */
  async settle(matchId: string): Promise<void> {
    const match = await this.matches.findMatch(matchId);
    if (!match || (match.status !== 'settling' && match.status !== 'in_progress')) return;

    const players = await this.matches.listPlayers(matchId);
    const definition = this.registry.get(match.gameCode, match.gameVersion);
    const state = await this.rebuildState(match, players, definition);

    // `settle` derives payouts from a terminal state and nothing else: no randomness, no
    // clock. Both are wired to throw here rather than merely discouraged in a comment,
    // because a settlement that is not reproducible cannot be re-derived in a dispute.
    const ctx = EngineService.context(
      match,
      players,
      () => {
        throw new Error('settle must not draw randomness');
      },
      EngineService.forbiddenClock('settle'),
    );
    const payouts = definition.settle(ctx, state as never);
    const instructions = payouts.map((payout) => ({ userId: payout.userId, amount: payout.amount }));

    // Which purse pays is a property the game declares, not something the engine infers
    // from its code (ADR-024, ADR-025).
    const banking = definition.meta.banking ?? 'pooled';
    const result =
      banking === 'table'
        ? await this.settleTableBanked(match, definition, ctx, state)
        : banking === 'house'
          ? await this.wallet.settleHouseBanked({ matchId, payouts: instructions })
          : await this.wallet.settle({ matchId, payouts: instructions });

    await withTransaction(this.pool, async (client) => {
      await this.matches.setStatus(client, matchId, 'settled');
      await this.audit.append(
        {
          actorType: 'system',
          action: 'game.settled',
          subjectRef: matchId,
          // The house leg is recorded because it is the number finance and risk read: a
          // payout implementation drifting from its configured edge shows up here first.
          payload: {
            gameCode: match.gameCode,
            banking,
            payouts,
            houseNet: 'houseNet' in result ? result.houseNet : 0,
          },
        },
        client,
      );
    });

    await this.realtime.broadcast(Rooms.match(matchId), 'game:settled', { matchId, payouts });
    await this.notifyChanged(matchId);
  }

  /**
   * Settles a table-banked match: the only money that moves is the house's cut (ADR-025).
   *
   * Chips are game state held inside a **table** escrow that outlives this match, so there
   * is nothing to pay out — the winner's chips are already in the account. Rake is the one
   * thing that leaves, and the engine posts it, never the game (rule 10).
   */
  private async settleTableBanked(
    match: MatchRow,
    definition: GameDefinition<never>,
    ctx: GameContext,
    state: unknown,
  ): Promise<{ transactionId: string | null; replayed: boolean }> {
    const tableId = String(match.config.tableId ?? '');
    if (!tableId) {
      // Without a table there is no escrow to take the cut from. Refusing leaves the match
      // in `settling` for a human rather than guessing where the money lives.
      throw new Error(`match ${match.id} is table-banked but names no table`);
    }

    const rake = definition.rakeFor ? definition.rakeFor(ctx, state as never) : 0;
    return this.wallet.settleTableHand({ tableId, matchId: match.id, rake });
  }

  /**
   * Voids a match and refunds every buy-in.
   *
   * Used when state cannot be rebuilt — a corrupted or diverged event log. Refunding is
   * the only defensible outcome: settling a match whose history cannot be trusted would
   * mean inventing a result, and keeping the stakes would mean taking money for a game
   * that never concluded.
   */
  async voidMatch(matchId: string, reason: string): Promise<void> {
    const match = await this.matches.findMatch(matchId);
    if (!match || match.status === 'settled' || match.status === 'voided') return;

    const players = await this.matches.listPlayers(matchId);

    // Refund exactly what each player staked, straight back out of escrow.
    await this.wallet.settle({
      matchId,
      payouts: players.filter((p) => p.stake > 0).map((p) => ({ userId: p.userId, amount: p.stake })),
    });

    await withTransaction(this.pool, async (client) => {
      await this.matches.setStatus(client, matchId, 'voided', { voidReason: reason });
      await this.audit.append(
        {
          actorType: 'system',
          action: 'game.voided',
          subjectRef: matchId,
          payload: { reason, refunded: players.map((p) => ({ userId: p.userId, amount: p.stake })) },
        },
        client,
      );
    });

    this.logger.warn(`match ${matchId} voided (${reason}); buy-ins refunded`);
    await this.realtime.broadcast(Rooms.match(matchId), 'game:voided', { matchId, reason });
    await this.notifyChanged(matchId);
  }

  /** The player-filtered view — the only state a client ever receives. */
  async viewFor(matchId: string, userId: string): Promise<Record<string, unknown>> {
    const match = await this.matches.findMatch(matchId);
    if (!match) throw new MatchNotFoundError();

    const players = await this.matches.listPlayers(matchId);
    if (!players.some((player) => player.userId === userId)) throw new NotAParticipantError();

    const definition = this.registry.get(match.gameCode, match.gameVersion);
    const state = await this.rebuildState(match, players, definition);
    // A live clock here is correct and deliberate: `playerView` is never replayed, and a
    // round game's view legitimately depends on how long the round has been running.
    const ctx = EngineService.context(
      match,
      players,
      () => {
        throw new Error('playerView must not draw randomness');
      },
      () => Date.now(),
    );

    return {
      matchId,
      status: match.status,
      gameCode: match.gameCode,
      view: definition.playerView(ctx, state as never, userId),
    };
  }

  /**
   * The spectator view — what a shared round room may carry.
   *
   * Returns null for a game that declares no public view, which is the safe answer: a
   * game that has not said what outsiders may see does not get to broadcast anything.
   */
  async publicViewFor(matchId: string): Promise<Record<string, unknown> | null> {
    const match = await this.matches.findMatch(matchId);
    if (!match) throw new MatchNotFoundError();

    const definition = this.registry.get(match.gameCode, match.gameVersion);
    if (!definition.publicView) return null;

    const players = await this.matches.listPlayers(matchId);
    const state = await this.rebuildState(match, players, definition);
    const ctx = EngineService.context(
      match,
      players,
      () => {
        throw new Error('publicView must not draw randomness');
      },
      () => Date.now(),
    );

    return {
      matchId,
      status: match.status,
      gameCode: match.gameCode,
      ...definition.publicView(ctx, state as never),
    };
  }

  /**
   * Arms the deadline the current state calls for, if the game defines one.
   *
   * Called after `init` and after recovery has replayed a match back into memory — the
   * two points where a deadline exists but no move produced it.
   */
  async armPendingTimer(matchId: string): Promise<void> {
    const match = await this.matches.findMatch(matchId);
    if (!match || match.status !== 'in_progress') return;

    const definition = this.registry.get(match.gameCode, match.gameVersion);
    if (!definition.pendingTimer) return;

    const players = await this.matches.listPlayers(matchId);
    const state = await this.rebuildState(match, players, definition);
    const ctx = EngineService.context(
      match,
      players,
      () => {
        throw new Error('pendingTimer must not draw randomness');
      },
      () => Date.now(),
    );

    const timer = definition.pendingTimer(ctx, state as never);
    if (timer) this.scheduleTimer(matchId, timer);
  }

  /**
   * In-process notification that a match moved.
   *
   * Round games need to publish their own lifecycle to a shared room, and the engine is
   * the only thing that knows when a round actually started or crashed. Deliberately
   * in-process and best-effort: it drives presentation, never money. Anything that must
   * survive a restart reads PostgreSQL instead.
   */
  onMatchChanged(listener: (change: MatchChange) => void | Promise<void>): void {
    this.changeListeners.push(listener);
  }

  private async notifyChanged(matchId: string): Promise<void> {
    if (this.changeListeners.length === 0) return;
    const match = await this.matches.findMatch(matchId);
    if (!match) return;

    for (const listener of this.changeListeners) {
      try {
        await listener({ matchId, gameCode: match.gameCode, status: match.status });
      } catch (error) {
        // A listener is a spectator of the engine; it must never be able to fail a match.
        this.logger.warn(
          `match-change listener failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
  }

  /**
   * Rebuilds state from the latest snapshot plus subsequent events.
   *
   * State is deliberately re-derived rather than cached in memory: the event log is the
   * authority, so an engine that just restarted and one that has been running for hours
   * compute the same thing. Redis caching is an optimisation for later, and it must never
   * become the place state actually lives (rule 7).
   */
  private async rebuildState(
    match: MatchRow,
    players: GamePlayer[],
    definition: GameDefinition<never>,
    client?: PoolClient,
  ): Promise<unknown> {
    const snapshot = await this.matches.latestSnapshot(match.id, client);
    const events = await this.matches.listEvents(match.id, snapshot?.seq ?? 0, client);

    if (snapshot) {
      // Events carry the post-reduce state, so the newest one is authoritative.
      const last = events.at(-1);
      return last ? (last.payload.state as unknown) : snapshot.state;
    }

    const last = events.at(-1);
    if (!last) throw new Error(`match ${match.id} has no events to rebuild from`);
    return last.payload.state as unknown;
  }

  /**
   * Replays a match from its first event and **compares the result to what was recorded**.
   *
   * Re-running the reducer without comparing would only prove the log does not crash the
   * game — it would happily accept tampered state or logic that has silently diverged.
   * Checking each replayed state against the stored one is what makes this a real
   * verification: it catches edited events, corrupted RNG draws, and rule changes applied
   * to a match in flight.
   */
  async replayAndVerify(matchId: string): Promise<{ ok: boolean; reason?: string }> {
    const match = await this.matches.findMatch(matchId);
    if (!match) return { ok: false, reason: 'match not found' };

    try {
      const players = await this.matches.listPlayers(matchId);
      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const events = await this.matches.listEvents(matchId, 0);
      if (events.length === 0) return { ok: false, reason: 'no events' };

      const initEvent = events[0]!;
      let state = definition.init(this.replayContext(match, players, initEvent)) as unknown;

      const mismatch = EngineService.compareState(state, initEvent.payload.state, initEvent.seq);
      if (mismatch) return { ok: false, reason: mismatch };

      for (const event of events.slice(1)) {
        const ctx = this.replayContext(match, players, event);

        if (event.type === 'match:action') {
          const action = event.payload.action as GameAction;
          state = definition.reduce(ctx, state as never, action).state;
        } else if (event.type === 'match:timeout') {
          state = definition.onTimeout(ctx, state as never, String(event.payload.timerId)).state;
        } else {
          continue;
        }

        const divergence = EngineService.compareState(state, event.payload.state, event.seq);
        if (divergence) return { ok: false, reason: divergence };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'replay failed' };
    }
  }

  /**
   * A context that replays what the original run consumed.
   *
   * Both sources of non-determinism come from the event itself: the RNG draws it recorded
   * and the clock reads it recorded. Replay therefore reproduces the match that was
   * played, not a fresh one that merely follows the same rules.
   */
  private replayContext(match: MatchRow, players: GamePlayer[], event: { payload: Record<string, unknown> }): GameContext {
    const draws = (event.payload.__draws as RngDraw[] | undefined) ?? [];
    const reads = (event.payload.__clock as number[] | undefined) ?? [];
    return EngineService.context(
      match,
      players,
      this.rng.createReplayer(draws).random,
      this.clock.createReplayer(reads).now,
    );
  }

  /** Returns a description of the divergence, or null when the states match. */
  private static compareState(replayed: unknown, recorded: unknown, seq: number): string | null {
    if (recorded === undefined) return null;
    // Canonical form on both sides: the recorded value has been through jsonb, which does
    // not preserve key order, so a plain stringify comparison would flag every match.
    const a = canonicalStringify(replayed);
    const b = canonicalStringify(recorded);
    return a === b ? null : `state divergence at seq ${seq}: replay does not match the recorded state`;
  }

  private async applyTimer(matchId: string, reduced: ReduceResult<never>): Promise<void> {
    if (!reduced.timer) return;
    this.scheduleTimer(matchId, reduced.timer);
  }

  private scheduleTimer(matchId: string, timer: { id: string; delayMs: number }): void {
    this.timers.schedule(`${matchId}:${timer.id}`, timer.delayMs, () =>
      this.handleTimeout(matchId, timer.id),
    );
  }

  /**
   * Hands a reducer's events to the realtime layer.
   *
   * Called only after the transaction has committed: an action that was rejected or rolled
   * back must never have announced itself. The realtime layer decides routing — public
   * events to the match room, private ones to their owner's room — because that is what
   * keeps a private event out of the shared replay buffer (ADR-023 §4, PHASE-09).
   */
  private async deliverEvents(
    matchId: string,
    reduced: ReduceResult<never>,
    players: GamePlayer[],
    matchSeq: number,
  ): Promise<void> {
    if (reduced.events.length === 0) return;
    await this.realtime.deliver(matchId, reduced.events, {
      matchSeq,
      participants: players.map((player) => player.userId),
    });
  }

  /** Sends each participant their own view — never a shared blob (rule 2). */
  private async broadcastState(matchId: string): Promise<void> {
    const players = await this.matches.listPlayers(matchId);
    for (const player of players) {
      const view = await this.viewFor(matchId, player.userId);
      await this.realtime.toUser(player.userId, 'game:state', view);
    }
  }

  /**
   * Builds the context a reducer runs against.
   *
   * Both non-deterministic capabilities are injected rather than reached for: recording
   * drawers during play, replaying ones during recovery, throwing ones where the hook is
   * required to be pure. A game cannot opt out — `Math.random()` and `Date.now()` are
   * simply not in scope inside a reducer.
   */
  private static context(
    match: MatchRow,
    players: GamePlayer[],
    random: (max: number, purpose: string) => number,
    now: () => number,
  ): GameContext {
    return { matchId: match.id, players, config: match.config, random, now };
  }

  /** A clock for hooks that must be deterministic — `settle` derives from terminal state. */
  private static forbiddenClock(hook: string): () => number {
    return () => {
      throw new Error(`${hook} must not read the clock: its result has to be replayable`);
    };
  }
}
