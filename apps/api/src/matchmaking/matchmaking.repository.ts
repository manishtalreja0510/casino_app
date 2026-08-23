import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';

export interface StakeTier {
  id: string;
  gameCode: string;
  name: string;
  stake: number;
  currency: string;
  enabled: boolean;
}

@Injectable()
export class MatchmakingRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listTiers(gameCode?: string): Promise<StakeTier[]> {
    const { rows } = await this.pool.query(
      `SELECT id, game_code, name, stake, currency, enabled
         FROM game.stake_tiers
        WHERE enabled = true AND ($1::text IS NULL OR game_code = $1)
        ORDER BY game_code, sort_order`,
      [gameCode ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      gameCode: row.game_code,
      name: row.name,
      stake: Number(row.stake),
      currency: row.currency,
      enabled: row.enabled,
    }));
  }

  async findTier(tierId: string): Promise<StakeTier | null> {
    const { rows } = await this.pool.query(
      `SELECT id, game_code, name, stake, currency, enabled FROM game.stake_tiers WHERE id = $1`,
      [tierId],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          gameCode: row.game_code,
          name: row.name,
          stake: Number(row.stake),
          currency: row.currency,
          enabled: row.enabled,
        }
      : null;
  }

  /**
   * Records what was formed — or why it was not.
   *
   * The live queue is Redis and expires; this is the durable answer to "I was charged but
   * never played", independent of a queue that no longer exists.
   */
  async recordFormation(
    input: {
      matchId: string | null;
      gameCode: string;
      tierId: string;
      userIds: string[];
      outcome: 'formed' | 'failed';
      reason?: string;
    },
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO game.formations (id, match_id, game_code, tier_id, user_ids, outcome, reason)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)`,
      [
        uuidv7(),
        input.matchId,
        input.gameCode,
        input.tierId,
        input.userIds,
        input.outcome,
        input.reason ?? null,
      ],
    );
  }

  /** Matches a player is currently seated in — used to keep them out of a second one. */
  async activeMatchesFor(userId: string, client?: PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query<{ match_id: string }>(
      `SELECT mp.match_id
         FROM game.match_players mp
         JOIN game.matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1 AND m.status IN ('created','starting','in_progress','settling')`,
      [userId],
    );
    return rows.map((row) => row.match_id);
  }

  async countActiveMatches(gameCode: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM game.matches
        WHERE game_code = $1 AND status IN ('starting','in_progress')`,
      [gameCode],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Participants of a match — the roster room authorisation checks against. */
  async isParticipant(matchId: string, userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM game.match_players WHERE match_id = $1 AND user_id = $2',
      [matchId, userId],
    );
    return rows.length > 0;
  }
}
