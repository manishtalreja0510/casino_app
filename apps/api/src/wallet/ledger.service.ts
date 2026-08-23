import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';
import { AuditService } from '../platform/audit/audit.service';

/** One side of a double-entry posting. Negative debits, positive credits. */
export interface LedgerEntryInput {
  accountId: string;
  /** Integer minor units (rule 4). Never zero. */
  amount: number;
  currency: string;
}

export interface PostInput {
  type: 'funding' | 'buy_in' | 'settlement' | 'rake' | 'reversal' | 'adjustment';
  /** Uniqueness key for the whole operation. A replay returns the original transaction. */
  idempotencyKey: string;
  entries: LedgerEntryInput[];
  refType?: string | null;
  refId?: string | null;
  reversesTxId?: string | null;
  createdBy?: string;
  /** Actor recorded in the audit entry written inside the same transaction. */
  audit: { actorType: 'user' | 'admin' | 'system'; actorId?: string | null; action: string };
}

export interface PostResult {
  transactionId: string;
  /** True when this call found an existing transaction for the key and posted nothing. */
  replayed: boolean;
}

export class LedgerError extends Error {}

/**
 * The **only** writer to the ledger (ADR-008).
 *
 * Everything money-related in the platform funnels through `post()`, which guarantees, in
 * a single database transaction:
 *  - entries sum to zero (also enforced by a deferred constraint trigger, so a bug here
 *    cannot corrupt the ledger),
 *  - the operation is idempotent by key,
 *  - balances are updated with the entries rather than after them,
 *  - an audit row is written that rolls back with the money if anything fails.
 *
 * Accounts are locked in a deterministic order, which is what makes concurrent postings
 * safe: two transfers touching the same pair of accounts can never each hold the lock the
 * other needs.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /**
   * The id an operation was already posted under, or null if it never was.
   *
   * Separate from `post` because a caller sometimes needs to know it is *about* to replay
   * before doing the work around the post — a responsible-gaming check, say, which a
   * replay must not consume, because a replay charges nothing (see `WalletService`).
   * Reading it is not a substitute for the unique index: two callers can still both read
   * "not posted" and race, and `post` resolves that.
   */
  async findPosted(client: PoolClient, idempotencyKey: string): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return rows[0]?.id ?? null;
  }

  async post(input: PostInput, existingClient?: PoolClient): Promise<PostResult> {
    if (existingClient) return this.postWith(existingClient, input);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.postWith(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async postWith(client: PoolClient, input: PostInput): Promise<PostResult> {
    LedgerService.validate(input);

    // Idempotency: an operation already posted under this key returns its original result.
    // Checked inside the transaction, and backed by a unique index in case two callers
    // race past this read simultaneously.
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { transactionId: existing.rows[0].id, replayed: true };
    }

    // Deterministic lock order prevents deadlock between concurrent postings.
    const accountIds = [...new Set(input.entries.map((entry) => entry.accountId))].sort();
    await client.query(
      `SELECT account_id FROM wallet.balances WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE`,
      [accountIds],
    );

    const txId = uuidv7();
    try {
      await client.query(
        `INSERT INTO wallet.ledger_transactions (id, type, idempotency_key, ref_type, ref_id, reverses_tx_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          txId,
          input.type,
          input.idempotencyKey,
          input.refType ?? null,
          input.refId ?? null,
          input.reversesTxId ?? null,
          input.createdBy ?? 'system',
        ],
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('ledger_transactions_idem_uq')) {
        // Lost the race; the winner's transaction is authoritative.
        const winner = await client.query<{ id: string }>(
          'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
          [input.idempotencyKey],
        );
        return { transactionId: winner.rows[0]!.id, replayed: true };
      }
      throw error;
    }

    for (const entry of input.entries) {
      await client.query(
        `INSERT INTO wallet.ledger_entries (id, tx_id, account_id, amount, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), txId, entry.accountId, entry.amount, entry.currency],
      );

      // The balance cache moves with its entries, in the same transaction — it cannot
      // drift by a crash between the two, only by a bug, which reconciliation catches.
      //
      // Deliberately two statements rather than an upsert with `DO UPDATE SET amount =
      // amount + EXCLUDED.amount`. PostgreSQL fires BEFORE INSERT triggers *before* it
      // detects the conflict, so the non-negative guard would see the raw delta (a
      // debit of -1000) instead of the resulting balance, and reject every withdrawal
      // from an existing account. Seeding the row at zero first keeps the guard looking
      // only at real balances.
      await client.query(
        `INSERT INTO wallet.balances (account_id, amount, currency)
         VALUES ($1, 0, $2)
         ON CONFLICT (account_id) DO NOTHING`,
        [entry.accountId, entry.currency],
      );
      await client.query(
        `UPDATE wallet.balances
            SET amount = amount + $2, version = version + 1, updated_at = now()
          WHERE account_id = $1`,
        [entry.accountId, entry.amount],
      );
    }

    await this.audit.append(
      {
        actorType: input.audit.actorType,
        actorId: input.audit.actorId ?? null,
        action: input.audit.action,
        subjectRef: txId,
        // Amounts and account ids only — no personal data (rule 15).
        payload: {
          type: input.type,
          entries: input.entries.map((entry) => ({
            accountId: entry.accountId,
            amount: entry.amount,
            currency: entry.currency,
          })),
          ...(input.refId ? { refType: input.refType, refId: input.refId } : {}),
        },
      },
      client,
    );

    return { transactionId: txId, replayed: false };
  }

  /** Application-side checks. The database enforces the same rules independently. */
  private static validate(input: PostInput): void {
    if (input.entries.length < 2) {
      throw new LedgerError('a ledger transaction needs at least two entries');
    }

    const currencies = new Set(input.entries.map((entry) => entry.currency));
    if (currencies.size > 1) {
      // No implicit conversion, ever: a transaction spanning currencies would have to
      // invent a rate, and an invented rate is invented money.
      throw new LedgerError('a ledger transaction cannot span currencies');
    }

    let sum = 0;
    for (const entry of input.entries) {
      if (!Number.isSafeInteger(entry.amount)) {
        throw new LedgerError(`amount must be an integer in minor units, got ${entry.amount}`);
      }
      if (entry.amount === 0) throw new LedgerError('a ledger entry cannot be zero');
      sum += entry.amount;
    }
    if (sum !== 0) throw new LedgerError(`entries must sum to zero, got ${sum}`);
  }
}
