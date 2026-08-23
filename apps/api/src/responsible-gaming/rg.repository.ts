import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';
import {
  windowStart,
  type ExclusionKind,
  type LimitPeriod,
  type LimitType,
  type RgExclusion,
  type RgLimit,
  type RgUsage,
} from './rg.types';

/** The only place `rg.*` tables are touched (rule 20). */
@Injectable()
export class RgRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listLimits(userId: string, client?: PoolClient): Promise<RgLimit[]> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT id, user_id, type, period, amount, origin, pending_amount, pending_effective_at
         FROM rg.limits WHERE user_id = $1`,
      [userId],
    );
    return rows.map(RgRepository.toLimit);
  }

  /**
   * Sets a limit, applying the asymmetry: stricter binds now, looser waits.
   *
   * The decision is made here, in one place, against the row as it currently stands —
   * rather than by a caller comparing values it read a moment ago.
   */
  async setLimit(
    client: PoolClient,
    input: {
      userId: string;
      type: LimitType;
      period: LimitPeriod;
      amount: number;
      coolingMs: number;
    },
  ): Promise<{ effective: 'immediate' | 'pending'; effectiveAt: Date | null }> {
    const existing = (await this.listLimits(input.userId, client)).find(
      (limit) => limit.type === input.type && limit.period === input.period && limit.origin === 'player',
    );

    if (!existing) {
      // A first limit is a restriction where none existed: immediate, always.
      await client.query(
        `INSERT INTO rg.limits (id, user_id, type, period, amount, origin)
         VALUES ($1, $2, $3, $4, $5, 'player')`,
        [uuidv7(), input.userId, input.type, input.period, input.amount],
      );
      return { effective: 'immediate', effectiveAt: null };
    }

    if (input.amount <= existing.amount) {
      await client.query(
        `UPDATE rg.limits
            SET amount = $2, pending_amount = NULL, pending_effective_at = NULL, updated_at = now()
          WHERE id = $1`,
        [existing.id, input.amount],
      );
      return { effective: 'immediate', effectiveAt: null };
    }

    const effectiveAt = new Date(Date.now() + input.coolingMs);
    await client.query(
      `UPDATE rg.limits
          SET pending_amount = $2, pending_effective_at = $3, updated_at = now()
        WHERE id = $1`,
      [existing.id, input.amount, effectiveAt],
    );
    return { effective: 'pending', effectiveAt };
  }

  /** Cancels a pending increase. A player changing their mind is taken at their word. */
  async cancelPending(client: PoolClient, userId: string, type: LimitType, period: LimitPeriod): Promise<void> {
    await client.query(
      `UPDATE rg.limits
          SET pending_amount = NULL, pending_effective_at = NULL, updated_at = now()
        WHERE user_id = $1 AND type = $2 AND period = $3 AND origin = 'player'`,
      [userId, type, period],
    );
  }

  /**
   * Promotes any pending increase whose cooling period has elapsed.
   *
   * Done lazily, on read, rather than by a job: a limit that has "become" looser but has
   * not been swept yet would otherwise still refuse a spend, which is the wrong direction
   * of error but is still wrong.
   */
  async promoteDueIncreases(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE rg.limits
          SET amount = pending_amount, pending_amount = NULL, pending_effective_at = NULL,
              updated_at = now()
        WHERE user_id = $1
          AND pending_amount IS NOT NULL
          AND pending_effective_at IS NOT NULL
          AND pending_effective_at <= now()`,
      [userId],
    );
  }

  async usageFor(
    client: PoolClient,
    userId: string,
    type: LimitType,
    period: LimitPeriod,
    at: Date,
  ): Promise<RgUsage> {
    const start = windowStart(period, at);
    const { rows } = await client.query(
      `SELECT type, period, window_start, spent, returned
         FROM rg.limit_usage
        WHERE user_id = $1 AND type = $2 AND period = $3 AND window_start = $4`,
      [userId, type, period, start],
    );
    const row = rows[0];
    return row
      ? {
          type,
          period,
          windowStart: row.window_start,
          spent: Number(row.spent),
          returned: Number(row.returned),
        }
      : { type, period, windowStart: start, spent: 0, returned: 0 };
  }

  /**
   * Meters a spend or a return.
   *
   * Runs in the caller's transaction — the same one that moves the money — so a spend
   * cannot commit without being counted, and a rolled-back spend is not counted.
   */
  async meter(
    client: PoolClient,
    input: {
      userId: string;
      type: LimitType;
      period: LimitPeriod;
      at: Date;
      spent?: number;
      returned?: number;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO rg.limit_usage (user_id, type, period, window_start, spent, returned)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, type, period, window_start) DO UPDATE
         SET spent = rg.limit_usage.spent + EXCLUDED.spent,
             returned = rg.limit_usage.returned + EXCLUDED.returned,
             updated_at = now()`,
      [
        input.userId,
        input.type,
        input.period,
        windowStart(input.period, input.at),
        input.spent ?? 0,
        input.returned ?? 0,
      ],
    );
  }

  /** The exclusion in force right now, if any. */
  async activeExclusion(userId: string, client?: PoolClient): Promise<RgExclusion | null> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT id, user_id, kind, starts_at, ends_at
         FROM rg.exclusions
        WHERE user_id = $1 AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
        ORDER BY starts_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0]
      ? {
          id: rows[0].id,
          userId: rows[0].user_id,
          kind: rows[0].kind,
          startsAt: rows[0].starts_at,
          endsAt: rows[0].ends_at,
        }
      : null;
  }

  async addExclusion(
    client: PoolClient,
    input: { userId: string; kind: ExclusionKind; endsAt: Date | null; source?: string },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO rg.exclusions (id, user_id, kind, ends_at, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.userId, input.kind, input.endsAt, input.source ?? 'player'],
    );
    return id;
  }

  /**
   * Returns accounts to `active` once nothing excludes them any more.
   *
   * A cool-off ends by its own end date; nobody lifts it, and nothing was watching for
   * that moment. Enforcement never depended on this — every check reads `rg.exclusions`
   * and honours `ends_at` to the second — but the *account status* did not move back, so
   * a player who took a week off was still labelled self-excluded a year later.
   *
   * Written as one set-based statement, and only ever in the direction of freedom: a row
   * is touched exactly when the account says excluded and no exclusion is in force. A
   * permanent self-exclusion has `ends_at IS NULL` and can never satisfy that.
   */
  async releaseLapsedExclusions(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE auth.users u
          SET status = 'active', updated_at = now()
        WHERE u.status = 'self_excluded'
          AND NOT EXISTS (
                SELECT 1 FROM rg.exclusions e
                 WHERE e.user_id = u.id
                   AND e.starts_at <= now()
                   AND (e.ends_at IS NULL OR e.ends_at > now()))
        RETURNING u.id`,
    );
    return rows.map((row) => row.id);
  }

  async listExclusions(userId: string): Promise<RgExclusion[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, kind, starts_at, ends_at FROM rg.exclusions
        WHERE user_id = $1 ORDER BY starts_at DESC LIMIT 50`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    }));
  }

  async realityCheck(
    userId: string,
    client?: PoolClient,
  ): Promise<{ intervalMs: number; lastShownAt: Date | null; lastAckAt: Date | null }> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT interval_ms, last_shown_at, last_ack_at FROM rg.reality_check_prefs WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return row
      ? {
          intervalMs: Number(row.interval_ms),
          lastShownAt: row.last_shown_at,
          lastAckAt: row.last_ack_at,
        }
      : { intervalMs: 30 * 60 * 1000, lastShownAt: null, lastAckAt: null };
  }

  /**
   * Players whose reality check has come due.
   *
   * Only rows that exist: a player who has never touched the setting has no row, and no
   * check is pushed at them until they ask for one. A default interval is what
   * `realityCheck` returns for reads, not a subscription created behind someone's back.
   *
   * Bounded, because this runs on a timer and the set it reads grows with the player base.
   * The ones it skips are simply picked up on the next pass a few seconds later.
   */
  async dueRealityChecks(limit = 200): Promise<Array<{ userId: string; intervalMs: number }>> {
    const { rows } = await this.pool.query(
      `SELECT user_id, interval_ms
         FROM rg.reality_check_prefs
        WHERE last_shown_at IS NULL
           OR last_shown_at + (interval_ms * interval '1 millisecond') <= now()
        ORDER BY last_shown_at NULLS FIRST
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({ userId: row.user_id, intervalMs: Number(row.interval_ms) }));
  }

  async setRealityCheckInterval(client: PoolClient, userId: string, intervalMs: number): Promise<void> {
    await client.query(
      `INSERT INTO rg.reality_check_prefs (user_id, interval_ms) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET interval_ms = EXCLUDED.interval_ms, updated_at = now()`,
      [userId, intervalMs],
    );
  }

  async markRealityCheckShown(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO rg.reality_check_prefs (user_id, last_shown_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_shown_at = now(), updated_at = now()`,
      [userId],
    );
  }

  async acknowledgeRealityCheck(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO rg.reality_check_prefs (user_id, last_ack_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_ack_at = now(), updated_at = now()`,
      [userId],
    );
  }

  async recordEvent(
    client: PoolClient,
    input: { userId: string; type: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    await client.query(`INSERT INTO rg.events (id, user_id, type, payload) VALUES ($1, $2, $3, $4)`, [
      uuidv7(),
      input.userId,
      input.type,
      JSON.stringify(input.payload ?? {}),
    ]);
  }

  async listEvents(userId: string, limit = 50): Promise<
    Array<{ type: string; payload: Record<string, unknown>; createdAt: Date }>
  > {
    const { rows } = await this.pool.query(
      `SELECT type, payload, created_at FROM rg.events
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row) => ({
      type: row.type,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  private static toLimit(row: Record<string, unknown>): RgLimit {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      type: row.type as LimitType,
      period: row.period as LimitPeriod,
      amount: Number(row.amount),
      origin: row.origin as RgLimit['origin'],
      pendingAmount: row.pending_amount === null ? null : Number(row.pending_amount),
      pendingEffectiveAt: (row.pending_effective_at as Date | null) ?? null,
    };
  }
}
