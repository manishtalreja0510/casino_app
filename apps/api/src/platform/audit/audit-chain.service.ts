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

  /** Rows read in one pass. Bounded so verification cannot be a whole-table load. */
  static readonly windowSize = 10_000;

  /**
   * Verifies the **entire** chain, a window at a time.
   *
   * This is what a caller should use. `verify()` reads one bounded window and says so;
   * this pages until the end, carrying each window's final hash into the next so the
   * boundary between them is checked like any other link.
   */
  async verifyAll(options: { windowSize?: number; maxRows?: number } = {}): Promise<AuditChainVerification> {
    const windowSize = options.windowSize ?? AuditChainService.windowSize;
    const maxRows = options.maxRows ?? 5_000_000;

    let fromSeq = 0;
    let checked = 0;
    let expectedPrevHash: Buffer | undefined;

    for (;;) {
      const { result: window, lastHash } = await this.verifyWindow({
        fromSeq,
        limit: windowSize,
        ...(expectedPrevHash ? { expectedPrevHash } : {}),
      });
      checked += window.checked;

      if (!window.valid) return { ...window, checked };
      if (window.complete) return { valid: true, checked, complete: true };

      if (checked >= maxRows) {
        // Reported, never rounded up to "valid". An audit chain that is too large to walk
        // is an operational problem to solve, not a result to accept.
        this.logger.error(
          `audit chain verification stopped after ${checked} rows without reaching the end`,
        );
        return {
          valid: true,
          checked,
          complete: false,
          nextFromSeq: window.nextFromSeq,
          reason: `stopped at the ${maxRows}-row cap; the chain is NOT fully verified`,
        };
      }

      fromSeq = window.nextFromSeq!;
      expectedPrevHash = lastHash;
    }
  }

  /**
   * Walks one window of the chain from `fromSeq` and re-computes every hash.
   *
   * Returns `complete: false` when the window filled, so the caller knows the answer
   * covers a prefix rather than the chain. Prefer `verifyAll()` unless you specifically
   * want one window.
   */
  async verify(
    options: { fromSeq?: number; limit?: number; expectedPrevHash?: Buffer } = {},
  ): Promise<AuditChainVerification> {
    return (await this.verifyWindow(options)).result;
  }

  /**
   * One window, plus the hash of its last row so a paged walk can link windows together.
   *
   * The hash is returned rather than kept on the service: a field would be shared mutable
   * state on a singleton, and two verifications running at once would corrupt each other's
   * boundary check — in a component whose entire job is detecting corruption.
   */
  private async verifyWindow(
    options: { fromSeq?: number; limit?: number; expectedPrevHash?: Buffer } = {},
  ): Promise<{ result: AuditChainVerification; lastHash?: Buffer }> {
    const { fromSeq = 0, limit = AuditChainService.windowSize } = options;

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
      // Nothing left to read: the walk reached the end of the chain.
      return { result: { valid: true, checked: 0, complete: true } };
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

    // From the beginning, the first row must chain to the genesis hash. Continuing a
    // paged walk, the caller supplies the previous window's last hash so the boundary is
    // checked too; only a caller starting mid-chain with no context skips that one link.
    let expectedPrev: Buffer | null = fromSeq === 0 ? GENESIS_HASH : (options.expectedPrevHash ?? null);

    for (const row of chain) {
      // Link check: this row's prev_hash must equal the previous row's hash.
      if (expectedPrev !== null && !row.prevHash.equals(expectedPrev)) {
        return {
          result: {
            valid: false,
            checked: chain.indexOf(row) + 1,
            complete: false,
            brokenAtSeq: row.seq,
            reason: 'prev_hash does not match the previous row hash — a row was altered or removed',
          },
        };
      }

      // Content check: the stored hash must match a re-computation from the row's data.
      const recomputed = computeHash(row.prevHash, row);
      if (!recomputed.equals(row.hash)) {
        return {
          result: {
            valid: false,
            checked: chain.indexOf(row) + 1,
            complete: false,
            brokenAtSeq: row.seq,
            reason: 'row content does not match its hash — the row was tampered with',
          },
        };
      }

      expectedPrev = row.hash;
    }

    const last = chain.at(-1)!;

    // A full window means there is probably more. Saying so is the whole point: the
    // previous version returned `valid: true` here and a caller had no way to tell a
    // verified chain from a verified prefix — so a database with more rows than the
    // window would report "intact" while never reading anything recent.
    const complete = chain.length < limit;
    return {
      result: {
        valid: true,
        checked: chain.length,
        complete,
        ...(complete ? {} : { nextFromSeq: last.seq }),
      },
      lastHash: last.hash,
    };
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
