import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  GameAction,
  GameContext,
  GameDefinition,
  GamePlayer,
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
import {
  GameDisabledError,
  InvalidActionError,
  MatchNotFoundError,
  MatchNotPlayableError,
  NotAParticipantError,
} from './engine.errors';

/** How many events between snapshots. Bounds replay cost without making snapshots the truth. */
const SNAPSHOT_INTERVAL = 25;

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

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly registry: GameRegistry,
    private readonly matches: MatchRepository,
    private readonly rng: RngService,
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

  /** Initialises game state and moves the match to `in_progress`. */
  private async start(matchId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const match = await this.matches.lockMatch(client, matchId);
      if (!match) throw new MatchNotFoundError();
      if (match.status !== 'created') return;

      const definition = this.registry.get(match.gameCode, match.gameVersion);
      const players = await this.matches.listPlayers(matchId, client);
      const recorder = this.rng.createRecorder();
      const ctx = EngineService.context(match, players, recorder.random);

      const state = definition.init(ctx);

      await this.matches.setStatus(client, matchId, 'in_progress');
      await this.matches.appendEvent(client, {
        matchId,
        seq: 1,
        type: 'match:init',
        payload: { state: state as Record<string, unknown> },
        draws: recorder.draws,
      });
      await this.matches.saveSnapshot(client, matchId, 1, state);
    });

    await this.broadcastState(matchId);
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
      const ctx = EngineService.context(match, players, recorder.random);

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
      });

      if (seq % SNAPSHOT_INTERVAL === 0) {
        await this.matches.saveSnapshot(client, matchId, seq, reduced.state);
      }

      const terminal = definition.isTerminal(reduced.state as never);
      if (terminal) await this.matches.setStatus(client, matchId, 'settling');

      return { match, players, definition, reduced, terminal };
    });

    await this.applyTimer(matchId, result.reduced);
    await this.broadcastState(matchId);
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
      const ctx = EngineService.context(match, players, recorder.random);
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
      });

      const terminal = definition.isTerminal(reduced.state as never);
      if (terminal) await this.matches.setStatus(client, matchId, 'settling');
      return { reduced, terminal };
    });

    if (!result) return;
    await this.applyTimer(matchId, result.reduced);
    await this.broadcastState(matchId);
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

    const recorder = this.rng.createRecorder();
    const ctx = EngineService.context(match, players, recorder.random);
    const payouts = definition.settle(ctx, state as never);

    await this.wallet.settle({
      matchId,
      payouts: payouts.map((payout) => ({ userId: payout.userId, amount: payout.amount })),
    });

    await withTransaction(this.pool, async (client) => {
      await this.matches.setStatus(client, matchId, 'settled');
      await this.audit.append(
        {
          actorType: 'system',
          action: 'game.settled',
          subjectRef: matchId,
          payload: { gameCode: match.gameCode, payouts },
        },
        client,
      );
    });

    await this.realtime.broadcast(Rooms.match(matchId), 'game:settled', { matchId, payouts });
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
  }

  /** The player-filtered view — the only state a client ever receives. */
  async viewFor(matchId: string, userId: string): Promise<Record<string, unknown>> {
    const match = await this.matches.findMatch(matchId);
    if (!match) throw new MatchNotFoundError();

    const players = await this.matches.listPlayers(matchId);
    if (!players.some((player) => player.userId === userId)) throw new NotAParticipantError();

    const definition = this.registry.get(match.gameCode, match.gameVersion);
    const state = await this.rebuildState(match, players, definition);
    const ctx = EngineService.context(match, players, () => {
      throw new Error('playerView must not draw randomness');
    });

    return {
      matchId,
      status: match.status,
      gameCode: match.gameCode,
      view: definition.playerView(ctx, state as never, userId),
    };
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
      const initDraws = (initEvent.payload.__draws as RngDraw[] | undefined) ?? [];
      let state = definition.init(
        EngineService.context(match, players, this.rng.createReplayer(initDraws).random),
      ) as unknown;

      const mismatch = EngineService.compareState(state, initEvent.payload.state, initEvent.seq);
      if (mismatch) return { ok: false, reason: mismatch };

      for (const event of events.slice(1)) {
        const draws = (event.payload.__draws as RngDraw[] | undefined) ?? [];
        const ctx = EngineService.context(match, players, this.rng.createReplayer(draws).random);

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
    const { id, delayMs } = reduced.timer;
    this.timers.schedule(`${matchId}:${id}`, delayMs, () => this.handleTimeout(matchId, id));
  }

  /** Sends each participant their own view — never a shared blob (rule 2). */
  private async broadcastState(matchId: string): Promise<void> {
    const players = await this.matches.listPlayers(matchId);
    for (const player of players) {
      const view = await this.viewFor(matchId, player.userId);
      await this.realtime.toUser(player.userId, 'game:state', view);
    }
  }

  private static context(
    match: MatchRow,
    players: GamePlayer[],
    random: (max: number, purpose: string) => number,
  ): GameContext {
    return {
      matchId: match.id,
      players,
      config: match.config,
      random,
      now: () => Date.now(),
    };
  }
}
