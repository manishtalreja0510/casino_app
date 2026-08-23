import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../ids/uuid-v7';
import { PG_POOL } from '../database/database.module';
import { computeHash, GENESIS_HASH, type HashableAuditRow } from './audit.hash';
import type { AuditEntry } from './audit.types';

/**
 * Writer for the append-only, hash-chained audit log (rule 15).
 *
 * `append` takes an optional client so that an audit entry can join the caller's
 * transaction. Money and auth paths MUST pass their client: an action that rolls back
 * must not leave an audit row claiming it happened, and an action that commits must not
 * be able to commit without its audit row.
 *
 * Chain integrity under concurrency: the insert takes a transaction-scoped advisory lock
 * so two concurrent appends cannot read the same `prev_hash` and fork the chain.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** Arbitrary, stable key identifying the audit-chain lock. */
  private static readonly CHAIN_LOCK_KEY = 4_242_001;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async append(entry: AuditEntry, client?: PoolClient): Promise<string> {
    if (client) return this.appendWith(client, entry);

    const own = await this.pool.connect();
    try {
      await own.query('BEGIN');
      const id = await this.appendWith(own, entry);
      await own.query('COMMIT');
      return id;
    } catch (error) {
      await own.query('ROLLBACK');
      throw error;
    } finally {
      own.release();
    }
  }

  private async appendWith(client: PoolClient, entry: AuditEntry): Promise<string> {
    await client.query('SELECT pg_advisory_xact_lock($1)', [AuditService.CHAIN_LOCK_KEY]);

    const { rows: headRows } = await client.query<{ hash: Buffer }>(
      'SELECT hash FROM audit.audit_log ORDER BY seq DESC LIMIT 1',
    );
    const prevHash = headRows[0]?.hash ?? GENESIS_HASH;

    const row: HashableAuditRow = {
      id: uuidv7(),
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      subjectRef: entry.subjectRef ?? null,
      payload: entry.payload ?? {},
      // Generated here rather than by the database so the hashed value is exactly the
      // value stored — `now()` would be read back after hashing.
      createdAt: new Date(),
    };

    await client.query(
      `INSERT INTO audit.audit_log
         (id, actor_type, actor_id, action, subject_ref, payload, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.actorType,
        row.actorId,
        row.action,
        row.subjectRef,
        JSON.stringify(row.payload),
        prevHash,
        computeHash(prevHash, row),
        row.createdAt,
      ],
    );

    return row.id;
  }
}
