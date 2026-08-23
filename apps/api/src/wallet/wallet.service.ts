import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { withTransaction } from '../platform/database/transaction';
import { FlagsService } from '../platform/flags/flags.service';
import { FlagKey } from '../platform/flags/flag-keys';
import { LedgerService } from './ledger.service';
import { WalletRepository, type TransactionSummary } from './wallet.repository';
import {
  CurrencyMismatchError,
  FundingDisabledError,
  FundingLimitExceededError,
  InsufficientFundsError,
} from './wallet.errors';

export const TEST_CURRENCY = 'TST';

/** Caps on the interim direct-credit path (ADR-022) — abuse signal for P10, not just a limit. */
export const FUNDING_LIMITS = {
  maxPerRequest: 1_000_00,
  maxPer24Hours: 5_000_00,
} as const;

export interface SettlementInstruction {
  userId: string;
  /** Positive: the player is paid this much from escrow. */
  amount: number;
}

/**
 * Wallet domain operations (`docs/02-domains/wallet.md`).
 *
 * Every method here is a thin, auditable composition of `LedgerService.post()`. Nothing
 * in this class computes a balance by hand or writes to the ledger directly — and games
 * never call it at all: settlement flows engine → wallet (rule 10).
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ledger: LedgerService,
    private readonly repository: WalletRepository,
    private readonly flags: FlagsService,
  ) {}

  async getBalance(userId: string, currency = TEST_CURRENCY): Promise<{ amount: number; currency: string }> {
    const account = await this.repository.findUserAccount(userId, currency);
    if (!account) return { amount: 0, currency };
    const balance = await this.repository.getBalance(account.id);
    return { amount: balance?.amount ?? 0, currency };
  }

  async listTransactions(
    userId: string,
    options: { limit?: number; before?: Date } = {},
  ): Promise<TransactionSummary[]> {
    const account = await this.repository.findUserAccount(userId, TEST_CURRENCY);
    if (!account) return [];
    return this.repository.listTransactions(account.id, {
      limit: Math.min(options.limit ?? 50, 100),
      ...(options.before ? { before: options.before } : {}),
    });
  }

  /**
   * Interim direct-credit funding (ADR-022, OQ-02): the user names an amount and it is
   * credited from a house funding account.
   *
   * **Double gate.** The operation requires its own flag to be ON *and* the compliance
   * gate to be OFF. It creates money by construction, so it must be unreachable the
   * moment real money is enabled — the check is here in the service, not merely a flag
   * default, and `funding_disabled_by_compliance_gate` is asserted by a test.
   */
  async addFunds(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    currency?: string;
  }): Promise<{ transactionId: string; replayed: boolean; balance: number }> {
    const currency = input.currency ?? TEST_CURRENCY;
    if (currency !== TEST_CURRENCY) throw new CurrencyMismatchError();

    const [fundingEnabled, realMoneyEnabled] = await Promise.all([
      this.flags.isEnabled(FlagKey.DEV_DIRECT_CREDIT),
      this.flags.isRealMoneyEnabled(),
    ]);
    if (!fundingEnabled || realMoneyEnabled) {
      if (realMoneyEnabled) {
        this.logger.error(
          'direct-credit funding attempted while the compliance gate is ON — refused (ADR-022)',
        );
      }
      throw new FundingDisabledError();
    }

    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new CurrencyMismatchError();
    }
    if (input.amount > FUNDING_LIMITS.maxPerRequest) {
      throw new FundingLimitExceededError(0);
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.repository.sumFundingSince(input.userId, since);
    if (recent + input.amount > FUNDING_LIMITS.maxPer24Hours) {
      throw new FundingLimitExceededError(24);
    }

    const result = await withTransaction(this.pool, async (client) => {
      const userAccount = await this.repository.ensureUserAccount(client, input.userId, currency);
      const houseAccount = await this.repository.ensureHouseAccount(client, 'house_dev_funding', currency);

      return this.ledger.post(
        {
          type: 'funding',
          idempotencyKey: input.idempotencyKey,
          entries: [
            { accountId: houseAccount.id, amount: -input.amount, currency },
            { accountId: userAccount.id, amount: input.amount, currency },
          ],
          audit: { actorType: 'user', actorId: input.userId, action: 'wallet.funding' },
        },
        client,
      );
    });

    const balance = await this.getBalance(input.userId, currency);
    return { ...result, balance: balance.amount };
  }

  /**
   * Moves a buy-in from a player's wallet into the match escrow.
   *
   * Overdraw is prevented by the database (`balances` CHECK via trigger), not by reading
   * the balance first — a read-then-write check is a race, and this is money.
   */
  async buyIn(
    input: {
      userId: string;
      matchId: string;
      amount: number;
      currency?: string;
    },
    /**
     * Join an existing transaction instead of opening one.
     *
     * Matchmaking seats several players at once and must charge all of them or none: a
     * partial formation would take one player's stake for a match that never started.
     * Passing the caller's client is what makes that atomic.
     */
    existingClient?: PoolClient,
  ): Promise<{ transactionId: string; replayed: boolean }> {
    const currency = input.currency ?? TEST_CURRENCY;
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new CurrencyMismatchError();

    const work = async (client: PoolClient) => {
      const userAccount = await this.repository.ensureUserAccount(client, input.userId, currency);
      const escrow = await this.repository.ensureEscrowAccount(client, input.matchId, currency);

      return this.ledger.post(
        {
          type: 'buy_in',
          // Idempotent per player per match: a retried join cannot charge twice.
          idempotencyKey: `buy_in:${input.matchId}:${input.userId}`,
          refType: 'match',
          refId: input.matchId,
          entries: [
            { accountId: userAccount.id, amount: -input.amount, currency },
            { accountId: escrow.id, amount: input.amount, currency },
          ],
          audit: { actorType: 'user', actorId: input.userId, action: 'wallet.buy_in' },
        },
        client,
      );
    };

    try {
      // When joining a caller's transaction, errors propagate so the WHOLE formation
      // rolls back — including buy-ins that already succeeded within it.
      return existingClient ? await work(existingClient) : await withTransaction(this.pool, work);
    } catch (error) {
      if (WalletService.isInsufficientFunds(error)) throw new InsufficientFundsError();
      throw error;
    }
  }

  /**
   * Settles a match: pays winners from escrow, sweeps any remainder as rake.
   *
   * Idempotent by match id, so a retried settlement — after a crash, say — pays once.
   * The escrow must end empty: that invariant is what reconciliation checks, and it is
   * why the rake entry is computed as the remainder rather than passed in.
   */
  async settle(input: {
    matchId: string;
    payouts: SettlementInstruction[];
    currency?: string;
  }): Promise<{ transactionId: string | null; replayed: boolean; rake: number }> {
    const currency = input.currency ?? TEST_CURRENCY;

    const idempotencyKey = `settlement:${input.matchId}`;

    return withTransaction(this.pool, async (client) => {
      // The idempotency check must come BEFORE any business validation. A retried
      // settlement — after a crash, a timeout, or an engine restart — finds the escrow
      // already emptied by the first attempt, so validating first would reject the very
      // replay that idempotency exists to make safe.
      const replay = await client.query<{ id: string }>(
        'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (replay.rows[0]) {
        const original = replay.rows[0].id;
        const rakeRows = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(e.amount), 0)::text AS total
             FROM wallet.ledger_entries e
             JOIN wallet.accounts a ON a.id = e.account_id
            WHERE e.tx_id = $1 AND a.type = 'rake'`,
          [original],
        );
        return { transactionId: original, replayed: true, rake: Number(rakeRows.rows[0]?.total ?? 0) };
      }

      const escrow = await this.repository.ensureEscrowAccount(client, input.matchId, currency);

      const { rows } = await client.query<{ amount: string }>(
        'SELECT amount FROM wallet.balances WHERE account_id = $1 FOR UPDATE',
        [escrow.id],
      );
      const escrowAmount = Number(rows[0]?.amount ?? 0);

      const totalPayout = input.payouts.reduce((sum, payout) => sum + payout.amount, 0);
      if (totalPayout > escrowAmount) {
        throw new Error(
          `settlement for match ${input.matchId} would pay ${totalPayout} from an escrow of ${escrowAmount}`,
        );
      }
      const rake = escrowAmount - totalPayout;

      // A free-play match moves no money: escrow is empty and every payout is zero.
      // Posting it would mean a transaction with a single zero entry, which the ledger
      // rightly refuses — so there is simply nothing to record. The match still settles;
      // only the ledger stays silent, because nothing happened in it.
      if (escrowAmount === 0 && totalPayout === 0) {
        return { transactionId: null, replayed: false, rake: 0 };
      }

      const entries = [{ accountId: escrow.id, amount: -escrowAmount, currency }];
      for (const payout of input.payouts) {
        if (payout.amount <= 0) continue;
        const account = await this.repository.ensureUserAccount(client, payout.userId, currency);
        entries.push({ accountId: account.id, amount: payout.amount, currency });
      }
      if (rake > 0) {
        const rakeAccount = await this.repository.ensureHouseAccount(client, 'rake', currency);
        entries.push({ accountId: rakeAccount.id, amount: rake, currency });
      }

      const result = await this.ledger.post(
        {
          type: 'settlement',
          idempotencyKey,
          refType: 'match',
          refId: input.matchId,
          entries,
          audit: { actorType: 'system', action: 'wallet.settlement' },
        },
        client,
      );
      return { ...result, rake };
    });
  }

  /**
   * Settles a **house-banked** round (ADR-024).
   *
   * The difference from `settle` is one line of arithmetic and one line of principle. In a
   * pooled game players are paid out of each other's stakes, so a payout can never exceed
   * escrow. Here the house is the counterparty: a player who cashes out at 5× is owed five
   * times what they put in, and the surplus comes from the house float. `house_main` is
   * therefore a *balancing* leg rather than a residual one — negative when the house pays,
   * positive when it collects — and it is the only account in the system allowed to run
   * below zero, by design (`docs/02-domains/wallet.md §1`).
   *
   * Everything else is identical to `settle` and deliberately so: idempotency is checked
   * before any validation (a retried settlement must find the escrow already emptied and
   * still succeed), escrow must end at exactly zero, and the whole thing is one ledger
   * transaction.
   */
  async settleHouseBanked(input: {
    matchId: string;
    payouts: SettlementInstruction[];
    currency?: string;
  }): Promise<{ transactionId: string | null; replayed: boolean; houseNet: number }> {
    const currency = input.currency ?? TEST_CURRENCY;
    const idempotencyKey = `settlement:${input.matchId}`;

    return withTransaction(this.pool, async (client) => {
      const replay = await client.query<{ id: string }>(
        'SELECT id FROM wallet.ledger_transactions WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (replay.rows[0]) {
        const original = replay.rows[0].id;
        const houseRows = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(e.amount), 0)::text AS total
             FROM wallet.ledger_entries e
             JOIN wallet.accounts a ON a.id = e.account_id
            WHERE e.tx_id = $1 AND a.type = 'house_main'`,
          [original],
        );
        return {
          transactionId: original,
          replayed: true,
          houseNet: Number(houseRows.rows[0]?.total ?? 0),
        };
      }

      const escrow = await this.repository.ensureEscrowAccount(client, input.matchId, currency);
      const { rows } = await client.query<{ amount: string }>(
        'SELECT amount FROM wallet.balances WHERE account_id = $1 FOR UPDATE',
        [escrow.id],
      );
      const escrowAmount = Number(rows[0]?.amount ?? 0);

      const totalPayout = input.payouts.reduce((sum, payout) => sum + payout.amount, 0);
      if (!Number.isSafeInteger(totalPayout) || totalPayout < 0) {
        throw new Error(`settlement for match ${input.matchId} has a non-integer total payout`);
      }

      // Positive: the house collected losing stakes. Negative: the house paid winnings.
      const houseNet = escrowAmount - totalPayout;

      // A free-play round moves nothing at all — no stakes escrowed, nothing owed. There
      // is no ledger transaction to write, and writing one would mean a transaction of
      // zero-value entries, which the ledger rightly refuses.
      if (escrowAmount === 0 && totalPayout === 0) {
        return { transactionId: null, replayed: false, houseNet: 0 };
      }

      const entries = [];
      if (escrowAmount !== 0) {
        entries.push({ accountId: escrow.id, amount: -escrowAmount, currency });
      }
      for (const payout of input.payouts) {
        if (payout.amount <= 0) continue;
        const account = await this.repository.ensureUserAccount(client, payout.userId, currency);
        entries.push({ accountId: account.id, amount: payout.amount, currency });
      }
      if (houseNet !== 0) {
        const house = await this.repository.ensureHouseAccount(client, 'house_main', currency);
        entries.push({ accountId: house.id, amount: houseNet, currency });
      }

      const result = await this.ledger.post(
        {
          type: 'settlement',
          idempotencyKey,
          refType: 'match',
          refId: input.matchId,
          entries,
          audit: { actorType: 'system', action: 'wallet.settlement' },
        },
        client,
      );

      if (houseNet < 0) {
        // Not an error — it is what a house-banked game losing a round looks like. Logged
        // because the running house float is an operational number somebody has to watch,
        // and P10/P12 turn it into an alert rather than a line in a log.
        this.logger.log(
          `match ${input.matchId}: house paid ${-houseNet} ${currency} net to players`,
        );
      }

      return { ...result, houseNet };
    });
  }

  /**
   * Moves a buy-in from a player's wallet into a **table** escrow (ADR-025).
   *
   * The difference from `buyIn` is what the money is for: a match escrow is emptied by
   * that match's settlement, while a table escrow holds chips across every hand played
   * there and is emptied when the player stands up. Idempotent per seat session, so a
   * retried sit-down seats the player once and charges once.
   */
  async sitDown(
    input: {
      userId: string;
      tableId: string;
      seatSessionId: string;
      amount: number;
      currency?: string;
    },
    /**
     * Join the caller's transaction, so seating and paying commit together.
     *
     * A seat without a buy-in is a player at the table with money they never paid; a
     * buy-in without a seat is money taken for a chair they never got. Neither is
     * recoverable by a retry, so they share one transaction.
     */
    existingClient?: PoolClient,
  ): Promise<{ transactionId: string; replayed: boolean }> {
    const currency = input.currency ?? TEST_CURRENCY;
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new CurrencyMismatchError();

    const work = async (client: PoolClient) => {
      {
        const userAccount = await this.repository.ensureUserAccount(client, input.userId, currency);
        const escrow = await this.repository.ensureTableAccount(client, input.tableId, currency);

        return this.ledger.post(
          {
            type: 'buy_in',
            idempotencyKey: `table_buy_in:${input.seatSessionId}`,
            refType: 'table',
            refId: input.tableId,
            entries: [
              { accountId: userAccount.id, amount: -input.amount, currency },
              { accountId: escrow.id, amount: input.amount, currency },
            ],
            audit: { actorType: 'user', actorId: input.userId, action: 'wallet.table_buy_in' },
          },
          client,
        );
      }
    };

    try {
      return existingClient ? await work(existingClient) : await withTransaction(this.pool, work);
    } catch (error) {
      if (WalletService.isInsufficientFunds(error)) throw new InsufficientFundsError();
      throw error;
    }
  }

  /**
   * Returns a stack from the table escrow to its owner's wallet.
   *
   * Idempotent per seat session: standing up twice — a retry, a double tap, a reconnect
   * racing a timeout — pays out once. The amount comes from the caller because the stack
   * is game state, and the caller is the only thing that knows the hand has finished.
   */
  async standUp(
    input: {
      userId: string;
      tableId: string;
      seatSessionId: string;
      amount: number;
      currency?: string;
    },
    /** Join the caller's transaction, so leaving the seat and being paid commit together. */
    existingClient?: PoolClient,
  ): Promise<{ transactionId: string | null; replayed: boolean }> {
    const currency = input.currency ?? TEST_CURRENCY;
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new CurrencyMismatchError();

    // Standing up with nothing left is an ordinary outcome — you lost it all. There is no
    // transaction to write, and writing one of zero-value entries is what the ledger
    // rightly refuses.
    if (input.amount === 0) return { transactionId: null, replayed: false };

    const work = async (client: PoolClient) => {
      const userAccount = await this.repository.ensureUserAccount(client, input.userId, currency);
      const escrow = await this.repository.ensureTableAccount(client, input.tableId, currency);

      return this.ledger.post(
        {
          type: 'settlement',
          idempotencyKey: `table_cash_out:${input.seatSessionId}`,
          refType: 'table',
          refId: input.tableId,
          entries: [
            { accountId: escrow.id, amount: -input.amount, currency },
            { accountId: userAccount.id, amount: input.amount, currency },
          ],
          audit: { actorType: 'user', actorId: input.userId, action: 'wallet.table_cash_out' },
        },
        client,
      );
    };

    return existingClient ? work(existingClient) : withTransaction(this.pool, work);
  }

  /**
   * Settles one hand at a table: **rake only** (ADR-025).
   *
   * Everything else about a poker hand — who won which pot, how the stacks changed — is
   * game state inside an escrow that already holds the chips, so there is nothing for the
   * ledger to do. Idempotent by match id like every other settlement, so a retry after a
   * crash takes the rake once.
   */
  async settleTableHand(input: {
    tableId: string;
    matchId: string;
    rake: number;
    currency?: string;
  }): Promise<{ transactionId: string | null; replayed: boolean }> {
    const currency = input.currency ?? TEST_CURRENCY;
    if (!Number.isSafeInteger(input.rake) || input.rake < 0) {
      throw new Error(`match ${input.matchId} asked for a non-integer rake`);
    }

    // Zero rake is the normal case on `TST`, and the whole hand then moves no money at all.
    if (input.rake === 0) return { transactionId: null, replayed: false };

    return withTransaction(this.pool, async (client) => {
      const escrow = await this.repository.ensureTableAccount(client, input.tableId, currency);
      const rakeAccount = await this.repository.ensureHouseAccount(client, 'rake', currency);

      return this.ledger.post(
        {
          type: 'rake',
          idempotencyKey: `settlement:${input.matchId}`,
          refType: 'match',
          refId: input.matchId,
          entries: [
            { accountId: escrow.id, amount: -input.rake, currency },
            { accountId: rakeAccount.id, amount: input.rake, currency },
          ],
          audit: { actorType: 'system', action: 'wallet.rake' },
        },
        client,
      );
    });
  }

  /**
   * Reverses a transaction by posting its mirror image (rule 5: corrections are never edits).
   */
  async reverse(input: {
    transactionId: string;
    reason: string;
    actorId: string;
    actorType?: 'admin' | 'system';
  }): Promise<{ transactionId: string; replayed: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ account_id: string; amount: string; currency: string }>(
        'SELECT account_id, amount, currency FROM wallet.ledger_entries WHERE tx_id = $1',
        [input.transactionId],
      );
      if (rows.length === 0) throw new Error(`transaction ${input.transactionId} not found`);

      return this.ledger.post(
        {
          type: 'reversal',
          idempotencyKey: `reversal:${input.transactionId}`,
          reversesTxId: input.transactionId,
          entries: rows.map((row) => ({
            accountId: row.account_id,
            amount: -Number(row.amount),
            currency: row.currency,
          })),
          createdBy: input.actorId,
          audit: {
            actorType: input.actorType ?? 'admin',
            actorId: input.actorId,
            action: 'wallet.reversal',
          },
        },
        client,
      );
    });
  }

  private static isInsufficientFunds(error: unknown): boolean {
    return error instanceof Error && error.message.includes('insufficient funds');
  }
}
