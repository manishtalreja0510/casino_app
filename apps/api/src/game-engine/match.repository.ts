import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { GamePlayer, MatchStatus } from '@casino/contracts';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';
import type { RngDraw } from './rng.service';

export interface MatchRow {
  id: string;
  gameCode: string;
  gameVersion: number;
  status: MatchStatus;
  stake: number;
  currency: string;
  config: Record<string, unknown>;
  voidReason: string | null;
}

export interface StoredEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  actorId: string | null;
}

/** The only place `game.*` tables are touched (rule 20). */
@Injectable()
export class MatchRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createMatch(
    client: PoolClient,
    input: {
      gameCode: string;
      gameVersion: number;
      stake: number;
      currency: string;
      config: Record<string, unknown>;
      players: { userId: string; seat: number; stake: number }[];
    },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO game.matches (id, game_code, game_version, stake, currency, config)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.gameCode, input.gameVersion, input.stake, input.currency, JSON.stringify(input.config)],
    );
    for (const player of input.players) {
      await client.query(
        'INSERT INTO game.match_players (match_id, user_id, seat, stake) VALUES ($1, $2, $3, $4)',
        [id, player.userId, player.seat, player.stake],
      );
    }
    return id;
  }

  async findMatch(id: string, client?: PoolClient): Promise<MatchRow | null> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query(
      `SELECT id, game_code, game_version, status, stake, currency, config, void_reason
         FROM game.matches WHERE id = $1`,
      [id],
    );
    return rows[0] ? MatchRepository.toMatch(rows[0]) : null;
  }

  /** Locks the match row: two actions on one match must not interleave. */
  async lockMatch(client: PoolClient, id: string): Promise<MatchRow | null> {
    const { rows } = await client.query(
      `SELECT id, game_code, game_version, status, stake, currency, config, void_reason
         FROM game.matches WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? MatchRepository.toMatch(rows[0]) : null;
  }

  async listPlayers(matchId: string, client?: PoolClient): Promise<GamePlayer[]> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query(
      'SELECT user_id, seat, stake FROM game.match_players WHERE match_id = $1 ORDER BY seat',
      [matchId],
    );
    return rows.map((row) => ({ userId: row.user_id, seat: row.seat, stake: Number(row.stake) }));
  }

  async setStatus(
    client: PoolClient,
    matchId: string,
    status: MatchStatus,
    extra: { voidReason?: string } = {},
  ): Promise<void> {
    await client.query(
      `UPDATE game.matches
          SET status = $2,
              void_reason = COALESCE($3, void_reason),
              started_at = CASE WHEN $2 = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
              ended_at   = CASE WHEN $2 IN ('settled','voided') THEN now() ELSE ended_at END
        WHERE id = $1`,
      [matchId, status, extra.voidReason ?? null],
    );
  }

  async nextSeq(client: PoolClient, matchId: string): Promise<number> {
    const { rows } = await client.query<{ next: string }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM game.game_events WHERE match_id = $1',
      [matchId],
    );
    return Number(rows[0]!.next);
  }

  /**
   * Appends an event. The unique `(match_id, seq)` index is the last defence against two
   * concurrent writers producing a forked history — the row lock should prevent it, and
   * this makes the failure loud rather than silent.
   */
  async appendEvent(
    client: PoolClient,
    input: {
      matchId: string;
      seq: number;
      type: string;
      payload: Record<string, unknown>;
      actorId?: string | null;
      draws?: RngDraw[];
    },
  ): Promise<void> {
    const payload = input.draws?.length
      ? { ...input.payload, __draws: input.draws }
      : input.payload;

    await client.query(
      `INSERT INTO game.game_events (id, match_id, seq, type, payload, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), input.matchId, input.seq, input.type, JSON.stringify(payload), input.actorId ?? null],
    );
  }

  async listEvents(matchId: string, afterSeq = 0, client?: PoolClient): Promise<StoredEvent[]> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query(
      `SELECT seq, type, payload, actor_id FROM game.game_events
        WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [matchId, afterSeq],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      payload: row.payload as Record<string, unknown>,
      actorId: row.actor_id,
    }));
  }

  async saveSnapshot(
    client: PoolClient,
    matchId: string,
    seq: number,
    state: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO game.game_snapshots (match_id, seq, state) VALUES ($1, $2, $3)
       ON CONFLICT (match_id, seq) DO NOTHING`,
      [matchId, seq, JSON.stringify(state)],
    );
  }

  async latestSnapshot(
    matchId: string,
    client?: PoolClient,
  ): Promise<{ seq: number; state: unknown } | null> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query(
      'SELECT seq, state FROM game.game_snapshots WHERE match_id = $1 ORDER BY seq DESC LIMIT 1',
      [matchId],
    );
    return rows[0] ? { seq: Number(rows[0].seq), state: rows[0].state } : null;
  }

  /**
   * Matches left mid-play by a crash — the recovery sweep's input.
   *
   * Paged by id rather than by a bare LIMIT: a resumed match stays `in_progress`, so a
   * sweep that always read the first N would re-process the same ones forever and never
   * reach the rest. The cursor walks the whole set exactly once.
   */
  async findRecoverableMatches(limit = 100, afterId?: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM game.matches
        WHERE status IN ('starting','in_progress','settling')
          AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id ASC LIMIT $1`,
      [limit, afterId ?? null],
    );
    return rows.map((row) => row.id);
  }

  async countRecoverableMatches(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM game.matches
        WHERE status IN ('starting','in_progress','settling')`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private static toMatch(row: {
    id: string;
    game_code: string;
    game_version: number;
    status: MatchStatus;
    stake: string;
    currency: string;
    config: Record<string, unknown>;
    void_reason: string | null;
  }): MatchRow {
    return {
      id: row.id,
      gameCode: row.game_code,
      gameVersion: row.game_version,
      status: row.status,
      stake: Number(row.stake),
      currency: row.currency,
      config: row.config,
      voidReason: row.void_reason,
    };
  }
}
