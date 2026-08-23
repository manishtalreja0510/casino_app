import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { computeHash, GENESIS_HASH, type HashableAuditRow } from './audit.hash';
import type { AuditChainVerification } from './audit.types';

interface ChainRow extends HashableAuditRow {
  seq: number;
  prevHash: Buffer;
  hash: Buffer;
}

/**
 * Verifies the audit chain (rule 15).
 *
 * Hash-chaining does not prevent tampering — it makes tampering evident. Anyone with
 * database access can still edit bytes; what they cannot do is edit them without every
 * subsequent hash failing to match. A scheduled run of this service (P1 provides the
 * service; scheduling lands with the reconciliation jobs in P4) is what turns that
 * property into detection, and exporting the head hash off-system is what stops an
 * attacker from simply recomputing the whole chain.
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Walks the chain from `fromSeq` (default: the beginning) and re-computes every hash.
   * Verification starts from a row whose `prev_hash` is taken as given, so a window can
   * be checked without reading the whole table.
   */
  async verify(options: { fromSeq?: number; limit?: number } = {}): Promise<AuditChainVerification> {
    const { fromSeq = 0, limit = 10_000 } = options;

    const { rows } = await this.pool.query<{
      seq: string;
      id: string;
      actor_type: string;
      actor_id: string | null;
      action: string;
      subject_ref: string | null;
      payload: unknown;
      prev_hash: Buffer;
      hash: Buffer;
      created_at: Date;
    }>(
      `SELECT seq, id, actor_type, actor_id, action, subject_ref, payload, prev_hash, hash, created_at
         FROM audit.audit_log
        WHERE seq > $1
        ORDER BY seq ASC
        LIMIT $2`,
      [fromSeq, limit],
    );

    if (rows.length === 0) {
      return { valid: true, checked: 0 };
    }

    const chain: ChainRow[] = rows.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      subjectRef: r.subject_ref,
      payload: r.payload,
      createdAt: r.created_at,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));

    let expectedPrev: Buffer | null = fromSeq === 0 ? GENESIS_HASH : null;

    for (const row of chain) {
      // Link check: this row's prev_hash must equal the previous row's hash.
      if (expectedPrev !== null && !row.prevHash.equals(expectedPrev)) {
        return {
          valid: false,
          checked: chain.indexOf(row) + 1,
          brokenAtSeq: row.seq,
          reason: 'prev_hash does not match the previous row hash — a row was altered or removed',
        };
      }

      // Content check: the stored hash must match a re-computation from the row's data.
      const recomputed = computeHash(row.prevHash, row);
      if (!recomputed.equals(row.hash)) {
        return {
          valid: false,
          checked: chain.indexOf(row) + 1,
          brokenAtSeq: row.seq,
          reason: 'row content does not match its hash — the row was tampered with',
        };
      }

      expectedPrev = row.hash;
    }

    return { valid: true, checked: chain.length };
  }

  /** Head hash — exported to write-once external storage so the chain cannot be rebuilt silently. */
  async headHash(): Promise<{ seq: number; hash: string } | null> {
    const { rows } = await this.pool.query<{ seq: string; hash: Buffer }>(
      'SELECT seq, hash FROM audit.audit_log ORDER BY seq DESC LIMIT 1',
    );
    const head = rows[0];
    return head ? { seq: Number(head.seq), hash: head.hash.toString('hex') } : null;
  }
}
