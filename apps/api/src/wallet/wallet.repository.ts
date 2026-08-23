import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';

export type AccountType =
  | 'user_wallet'
  | 'house_main'
  | 'house_dev_funding'
  | 'rake'
  | 'bonus'
  | 'match_escrow'
  /** Poker: an escrow that outlives every hand played at a table (ADR-025). */
  | 'table_escrow';

export interface AccountRow {
  id: string;
  type: AccountType;
  userId: string | null;
  matchId: string | null;
  tableId: string | null;
  currency: string;
}

export interface TransactionSummary {
  id: string;
  type: string;
  amount: number;
  currency: string;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
}

/** The only place `wallet.*` tables are read or written outside the ledger primitive. */
@Injectable()
export class WalletRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Returns the account, creating it if absent.
   *
   * `ON CONFLICT DO NOTHING` plus a re-read makes this safe when two requests for the
   * same new wallet arrive together: exactly one insert wins and both see the same row.
   */
  async ensureUserAccount(client: PoolClient, userId: string, currency: string): Promise<AccountRow> {
    await client.query(
      `INSERT INTO wallet.accounts (id, type, user_id, currency)
       VALUES ($1, 'user_wallet', $2, $3)
       ON CONFLICT (user_id, currency) WHERE user_id IS NOT NULL DO NOTHING`,
      [uuidv7(), userId, currency],
    );
    const { rows } = await client.query(
      `SELECT id, type, user_id, match_id, table_id, currency FROM wallet.accounts
        WHERE user_id = $1 AND currency = $2`,
      [userId, currency],
    );
    return WalletRepository.toAccount(rows[0]);
  }

  async ensureHouseAccount(
    client: PoolClient,
    type: Exclude<AccountType, 'user_wallet' | 'match_escrow'>,
    currency: string,
  ): Promise<AccountRow> {
    await client.query(
      `INSERT INTO wallet.accounts (id, type, currency)
       VALUES ($1, $2, $3)
       ON CONFLICT (type, currency)
         WHERE user_id IS NULL AND match_id IS NULL AND table_id IS NULL DO NOTHING`,
      [uuidv7(), type, currency],
    );
    const { rows } = await client.query(
      `SELECT id, type, user_id, match_id, table_id, currency FROM wallet.accounts
        WHERE type = $1 AND currency = $2
          AND user_id IS NULL AND match_id IS NULL AND table_id IS NULL`,
      [type, currency],
    );
    return WalletRepository.toAccount(rows[0]);
  }

  /**
   * Escrow for a **table** — where poker stacks live (ADR-025).
   *
   * Distinct from a match escrow because it outlives every hand at the table: money enters
   * when someone sits down and leaves when they stand up, and the hands in between move
   * nothing but rake.
   */
  async ensureTableAccount(client: PoolClient, tableId: string, currency: string): Promise<AccountRow> {
    await client.query(
      `INSERT INTO wallet.accounts (id, type, table_id, currency)
       VALUES ($1, 'table_escrow', $2, $3)
       ON CONFLICT (table_id, currency) WHERE table_id IS NOT NULL DO NOTHING`,
      [uuidv7(), tableId, currency],
    );
    const { rows } = await client.query(
      `SELECT id, type, user_id, match_id, table_id, currency FROM wallet.accounts
        WHERE table_id = $1 AND currency = $2`,
      [tableId, currency],
    );
    return WalletRepository.toAccount(rows[0]);
  }

  /** Escrow for a match — the account a buy-in sits in until settlement. */
  async ensureEscrowAccount(client: PoolClient, matchId: string, currency: string): Promise<AccountRow> {
    await client.query(
      `INSERT INTO wallet.accounts (id, type, match_id, currency)
       VALUES ($1, 'match_escrow', $2, $3)
       ON CONFLICT (match_id, currency) WHERE match_id IS NOT NULL DO NOTHING`,
      [uuidv7(), matchId, currency],
    );
    const { rows } = await client.query(
      `SELECT id, type, user_id, match_id, table_id, currency FROM wallet.accounts
        WHERE match_id = $1 AND currency = $2`,
      [matchId, currency],
    );
    return WalletRepository.toAccount(rows[0]);
  }

  async findUserAccount(userId: string, currency: string): Promise<AccountRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, type, user_id, match_id, table_id, currency FROM wallet.accounts
        WHERE user_id = $1 AND currency = $2`,
      [userId, currency],
    );
    return rows[0] ? WalletRepository.toAccount(rows[0]) : null;
  }

  /** Cached balance. `null` when the account has never been funded. */
  async getBalance(accountId: string): Promise<{ amount: number; currency: string; version: number } | null> {
    const { rows } = await this.pool.query(
      'SELECT amount, currency, version FROM wallet.balances WHERE account_id = $1',
      [accountId],
    );
    const row = rows[0];
    return row ? { amount: Number(row.amount), currency: row.currency, version: Number(row.version) } : null;
  }

  /** Sum of entries — the ledger's own answer, used to check the cache (rule 9). */
  async getDerivedBalance(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount), 0)::text AS total FROM wallet.ledger_entries WHERE account_id = $1',
      [accountId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async listTransactions(
    accountId: string,
    options: { limit: number; before?: Date },
  ): Promise<TransactionSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.type, e.amount, e.currency, t.ref_type, t.ref_id, e.created_at
         FROM wallet.ledger_entries e
         JOIN wallet.ledger_transactions t ON t.id = e.tx_id
        WHERE e.account_id = $1
          AND ($2::timestamptz IS NULL OR e.created_at < $2)
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $3`,
      [accountId, options.before ?? null, options.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      amount: Number(row.amount),
      currency: row.currency,
      refType: row.ref_type,
      refId: row.ref_id,
      createdAt: row.created_at,
    }));
  }

  async findTransactionByIdempotencyKey(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
      [key],
    );
    return rows[0]?.id ?? null;
  }

  /** Sum of funding credited to a user within a window — the cap that limits faucet abuse. */
  async sumFundingSince(userId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.amount), 0)::text AS total
         FROM wallet.ledger_entries e
         JOIN wallet.ledger_transactions t ON t.id = e.tx_id
         JOIN wallet.accounts a ON a.id = e.account_id
        WHERE a.user_id = $1 AND t.type = 'funding' AND e.amount > 0 AND e.created_at >= $2`,
      [userId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }

  private static toAccount(row: {
    id: string;
    type: AccountType;
    user_id: string | null;
    match_id: string | null;
    table_id: string | null;
    currency: string;
  }): AccountRow {
    return {
      id: row.id,
      type: row.type,
      userId: row.user_id,
      matchId: row.match_id,
      tableId: row.table_id,
      currency: row.currency,
    };
  }
}
