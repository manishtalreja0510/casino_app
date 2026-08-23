import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';
import type { RiskAction, RiskRule } from './risk.types';

/** The only place `risk.*` tables are touched (rule 20). */
@Injectable()
export class RiskRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listRules(): Promise<RiskRule[]> {
    const { rows } = await this.pool.query(
      `SELECT type, weight, ttl_seconds, client_only, enabled FROM risk.rules`,
    );
    return rows.map((row) => ({
      type: row.type,
      weight: Number(row.weight),
      ttlSeconds: Number(row.ttl_seconds),
      clientOnly: row.client_only,
      enabled: row.enabled,
    }));
  }

  async recordSignal(
    input: {
      userId?: string | null;
      sessionId?: string | null;
      deviceId?: string | null;
      matchId?: string | null;
      source: string;
      type: string;
      payload: Record<string, unknown>;
      weight: number;
      clientOnly: boolean;
      ttlSeconds: number;
    },
    client?: PoolClient,
  ): Promise<string> {
    const id = uuidv7();
    await (client ?? this.pool).query(
      `INSERT INTO risk.signals
         (id, user_id, session_id, device_id, match_id, source, type, payload,
          weight_at_ingest, client_only, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))`,
      [
        id,
        input.userId ?? null,
        input.sessionId ?? null,
        input.deviceId ?? null,
        input.matchId ?? null,
        input.source,
        input.type,
        JSON.stringify(input.payload),
        input.weight,
        input.clientOnly,
        input.ttlSeconds,
      ],
    );
    return id;
  }

  /** Live signals for a user — expired ones stay in the table as evidence but stop counting. */
  async liveSignals(userId: string): Promise<
    Array<{ type: string; weight: number; clientOnly: boolean; createdAt: Date }>
  > {
    const { rows } = await this.pool.query(
      `SELECT type, weight_at_ingest, client_only, created_at
         FROM risk.signals
        WHERE user_id = $1 AND expires_at > now()
        ORDER BY created_at DESC LIMIT 500`,
      [userId],
    );
    return rows.map((row) => ({
      type: row.type,
      weight: Number(row.weight_at_ingest),
      clientOnly: row.client_only,
      createdAt: row.created_at,
    }));
  }

  /** Actions currently in force. Expired and lifted ones are history, not restrictions. */
  async activeActions(
    userId: string,
    client?: PoolClient,
  ): Promise<Array<{ action: RiskAction; reason: string }>> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT action, reason FROM risk.actions
        WHERE user_id = $1
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY applied_at DESC`,
      [userId],
    );
    return rows.map((row) => ({ action: row.action as RiskAction, reason: row.reason }));
  }

  /**
   * Serialises risk decisions about one user.
   *
   * Evaluation is read-then-write — read the score, read what already stands, apply the
   * rung that is missing — and several emitters evaluate the same user at once by design
   * (`ingest` fires evaluation without awaiting it, so a signal is never lost because
   * scoring failed). Without this lock two of them read "no freeze standing" at the same
   * moment and both apply one, which is two actions, two audit entries and, worst, two
   * cases for one player: duplicated review work on the exact path where a human is
   * deciding whether someone gets their money back.
   *
   * A transaction-scoped advisory lock rather than a unique index because "active" means
   * `expires_at > now()`, which no partial index can express.
   */
  async lockUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('risk:' || $1, 0))`, [
      userId,
    ]);
  }

  async applyAction(
    client: PoolClient,
    input: {
      userId: string;
      action: RiskAction;
      reason: string;
      evidence: Record<string, unknown>;
      appliedBy?: string;
      expiresAt?: Date | null;
    },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO risk.actions (id, user_id, action, reason, evidence, applied_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.userId,
        input.action,
        input.reason,
        JSON.stringify(input.evidence),
        input.appliedBy ?? 'system',
        input.expiresAt ?? null,
      ],
    );
    return id;
  }

  async liftAction(client: PoolClient, actionId: string, liftedBy: string): Promise<void> {
    await client.query(
      `UPDATE risk.actions SET lifted_at = now(), lifted_by = $2 WHERE id = $1 AND lifted_at IS NULL`,
      [actionId, liftedBy],
    );
  }

  async openCase(
    client: PoolClient,
    input: {
      userId: string;
      reason: string;
      evidence: Record<string, unknown>;
      priority?: 'low' | 'normal' | 'high';
    },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO risk.cases (id, user_id, reason, evidence, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.userId, input.reason, JSON.stringify(input.evidence), input.priority ?? 'normal'],
    );
    return id;
  }

  async openCasesFor(userId: string): Promise<Array<{ id: string; state: string; reason: string }>> {
    const { rows } = await this.pool.query(
      `SELECT id, state, reason FROM risk.cases
        WHERE user_id = $1 AND state <> 'resolved' ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({ id: row.id, state: row.state, reason: row.reason }));
  }

  // --- identity graph ------------------------------------------------------

  async linkDevice(deviceId: string, userId: string, client?: PoolClient): Promise<void> {
    await (client ?? this.pool).query(
      `INSERT INTO risk.device_links (device_id, user_id) VALUES ($1, $2)
       ON CONFLICT (device_id, user_id) DO UPDATE
         SET last_seen = now(), hits = risk.device_links.hits + 1`,
      [deviceId, userId],
    );
  }

  async linkIp(ip: string, userId: string, client?: PoolClient): Promise<void> {
    await (client ?? this.pool).query(
      `INSERT INTO risk.ip_links (ip, user_id) VALUES ($1, $2)
       ON CONFLICT (ip, user_id) DO UPDATE
         SET last_seen = now(), hits = risk.ip_links.hits + 1`,
      [ip, userId],
    );
  }

  /** How many distinct accounts share this device. */
  async accountsOnDevice(deviceId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM risk.device_links WHERE device_id = $1`,
      [deviceId],
    );
    return rows.map((row) => row.user_id);
  }

  async accountsOnIp(ip: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM risk.ip_links WHERE ip = $1`,
      [ip],
    );
    return rows.map((row) => row.user_id);
  }

  /** Whether two accounts have ever shared a device — the strongest link in the graph. */
  async shareADevice(a: string, b: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM risk.device_links x
         JOIN risk.device_links y ON y.device_id = x.device_id
        WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1`,
      [a, b],
    );
    return rows.length > 0;
  }

  /** Signals of a type for a user, for heuristics that need history rather than a score. */
  async recentSignalsOfType(
    type: string,
    userId: string,
    limit = 100,
  ): Promise<Array<{ payload: Record<string, unknown>; createdAt: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT payload, created_at FROM risk.signals
        WHERE type = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [type, userId, limit],
    );
    return rows.map((row) => ({
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }
}
