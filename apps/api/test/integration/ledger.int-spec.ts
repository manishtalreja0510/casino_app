import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { WalletService, TEST_CURRENCY } from '../../src/wallet/wallet.service';
import { WalletRepository } from '../../src/wallet/wallet.repository';
import { LedgerService, LedgerError } from '../../src/wallet/ledger.service';
import { ReconciliationService } from '../../src/wallet/reconciliation.service';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { InsufficientFundsError } from '../../src/wallet/wallet.errors';
import { withTransaction } from '../../src/platform/database/transaction';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

/**
 * The ledger's invariants are the platform's most important property: every later phase
 * moves money through this code. These tests exercise them against a real PostgreSQL,
 * including under genuine concurrency.
 */
describe('ledger & wallet (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let wallet: WalletService;
  let ledger: LedgerService;
  let repository: WalletRepository;
  let reconciliation: ReconciliationService;
  let flags: FlagsService;

  /** A user row is required because wallet accounts reference auth.users. */
  async function makeUser(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Ledger Test')`,
      [id, `ledger-${id}@example.test`],
    );
    return id;
  }

  async function fund(userId: string, amount: number): Promise<void> {
    await wallet.addFunds({ userId, amount, idempotencyKey: `seed:${uuidv7()}` });
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    wallet = app.get(WalletService);
    ledger = app.get(LedgerService);
    repository = app.get(WalletRepository);
    reconciliation = app.get(ReconciliationService);
    flags = app.get(FlagsService);

    // The interim funding path is off by default (ADR-022); tests enable it explicitly.
    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
  });

  afterAll(async () => {
    await flags.set(FlagKey.DEV_DIRECT_CREDIT, false, 'integration-test-cleanup');
    await app.close();
    await pool.end();
  });

  describe('database-enforced invariants', () => {
    it('REJECTS an unbalanced transaction at the database, not just in application code', async () => {
      const userId = await makeUser();
      // Bypass LedgerService.validate entirely: write the rows directly, the way a bug
      // (or a future careless code path) would.
      await expect(
        withTransaction(pool, async (client) => {
          const account = await repository.ensureUserAccount(client, userId, TEST_CURRENCY);
          const txId = uuidv7();
          await client.query(
            `INSERT INTO wallet.ledger_transactions (id, type, idempotency_key) VALUES ($1, 'adjustment', $2)`,
            [txId, `unbalanced:${txId}`],
          );
          await client.query(
            `INSERT INTO wallet.ledger_entries (id, tx_id, account_id, amount, currency)
             VALUES ($1, $2, $3, 500, $4)`,
            [uuidv7(), txId, account.id, TEST_CURRENCY],
          );
          // Committing here must fail: money would have been created from nothing.
        }),
      ).rejects.toThrow(/does not balance|at least two entries/);
    });

    it('REJECTS UPDATE and DELETE on ledger tables (rule 5)', async () => {
      const userId = await makeUser();
      await fund(userId, 1000);
      const { rows } = await pool.query('SELECT id, tx_id FROM wallet.ledger_entries LIMIT 1');

      await expect(
        pool.query('UPDATE wallet.ledger_entries SET amount = 999999 WHERE id = $1', [rows[0].id]),
      ).rejects.toThrow(/append-only/i);
      await expect(
        pool.query('DELETE FROM wallet.ledger_entries WHERE id = $1', [rows[0].id]),
      ).rejects.toThrow(/append-only/i);
      await expect(
        pool.query('DELETE FROM wallet.ledger_transactions WHERE id = $1', [rows[0].tx_id]),
      ).rejects.toThrow(/append-only/i);
    });

    it('REFUSES to let a player balance go negative', async () => {
      const userId = await makeUser();
      await fund(userId, 1000);
      await expect(
        wallet.buyIn({ userId, matchId: uuidv7(), amount: 5000 }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      const balance = await wallet.getBalance(userId);
      expect(balance.amount).toBe(1000);
    });

    it('rejects float amounts and cross-currency transactions in application code too', async () => {
      const userId = await makeUser();
      await withTransaction(pool, async (client) => {
        const account = await repository.ensureUserAccount(client, userId, TEST_CURRENCY);
        const house = await repository.ensureHouseAccount(client, 'house_main', TEST_CURRENCY);

        await expect(
          ledger.post(
            {
              type: 'adjustment',
              idempotencyKey: `float:${uuidv7()}`,
              entries: [
                { accountId: house.id, amount: -10.5, currency: TEST_CURRENCY },
                { accountId: account.id, amount: 10.5, currency: TEST_CURRENCY },
              ],
              audit: { actorType: 'system', action: 'test' },
            },
            client,
          ),
        ).rejects.toBeInstanceOf(LedgerError);

        await expect(
          ledger.post(
            {
              type: 'adjustment',
              idempotencyKey: `currency:${uuidv7()}`,
              entries: [
                { accountId: house.id, amount: -100, currency: TEST_CURRENCY },
                { accountId: account.id, amount: 100, currency: 'EUR' },
              ],
              audit: { actorType: 'system', action: 'test' },
            },
            client,
          ),
        ).rejects.toBeInstanceOf(LedgerError);
      });
    });
  });

  describe('idempotency (rule 6)', () => {
    it('posts once for a replayed key and reports the replay', async () => {
      const userId = await makeUser();
      const key = `funding:test:${uuidv7()}`;

      const first = await wallet.addFunds({ userId, amount: 2500, idempotencyKey: key });
      const second = await wallet.addFunds({ userId, amount: 2500, idempotencyKey: key });

      expect(second.transactionId).toBe(first.transactionId);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      // The decisive assertion: the money moved once.
      expect((await wallet.getBalance(userId)).amount).toBe(2500);
    });

    it('is idempotent under concurrent replays of the same key', async () => {
      const userId = await makeUser();
      const key = `funding:race:${uuidv7()}`;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          wallet.addFunds({ userId, amount: 1000, idempotencyKey: key }).catch((error) => error),
        ),
      );
      const succeeded = results.filter((r) => !(r instanceof Error));
      expect(succeeded.length).toBeGreaterThan(0);
      expect((await wallet.getBalance(userId)).amount).toBe(1000);
    });

    it('charges a buy-in once even if the join is retried', async () => {
      const userId = await makeUser();
      const matchId = uuidv7();
      await fund(userId, 10_000);

      await wallet.buyIn({ userId, matchId, amount: 2500 });
      const retry = await wallet.buyIn({ userId, matchId, amount: 2500 });

      expect(retry.replayed).toBe(true);
      expect((await wallet.getBalance(userId)).amount).toBe(7500);
    });
  });

  describe('concurrency', () => {
    it('50 concurrent debits never overdraw and never lose an update', async () => {
      const userId = await makeUser();
      await fund(userId, 10_000);

      // 50 buy-ins of 300 = 15,000 against a 10,000 balance: some MUST fail, and the
      // survivors must add up exactly. This is the test that catches a read-then-write race.
      const attempts = await Promise.all(
        Array.from({ length: 50 }, () =>
          wallet
            .buyIn({ userId, matchId: uuidv7(), amount: 300 })
            .then(() => 'ok' as const)
            .catch((error) => (error instanceof InsufficientFundsError ? ('rejected' as const) : error)),
        ),
      );

      const unexpected = attempts.filter((a) => a !== 'ok' && a !== 'rejected');
      expect(unexpected).toEqual([]);

      const succeeded = attempts.filter((a) => a === 'ok').length;
      const balance = await wallet.getBalance(userId);

      // Bounded on BOTH sides. An earlier version of this test only checked the upper
      // bound and the arithmetic, so it passed while every debit was being wrongly
      // rejected — a weak assertion hid a real bug. 10,000 / 300 = 33 buy-ins fit.
      expect(succeeded).toBe(33);
      expect(balance.amount).toBe(10_000 - succeeded * 300);
      expect(balance.amount).toBeGreaterThanOrEqual(0);

      // The cache must agree with the ledger after all that contention.
      const account = await repository.findUserAccount(userId, TEST_CURRENCY);
      expect(await repository.getDerivedBalance(account!.id)).toBe(balance.amount);
    });
  });

  describe('settlement', () => {
    it('pays winners from escrow and leaves it empty', async () => {
      const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
      const matchId = uuidv7();
      await Promise.all([fund(alice, 5000), fund(bob, 5000)]);

      await wallet.buyIn({ userId: alice, matchId, amount: 1000 });
      await wallet.buyIn({ userId: bob, matchId, amount: 1000 });

      const result = await wallet.settle({ matchId, payouts: [{ userId: alice, amount: 2000 }] });
      expect(result.rake).toBe(0);

      expect((await wallet.getBalance(alice)).amount).toBe(6000);
      expect((await wallet.getBalance(bob)).amount).toBe(4000);

      const { rows } = await pool.query(
        `SELECT b.amount FROM wallet.balances b JOIN wallet.accounts a ON a.id = b.account_id
          WHERE a.match_id = $1`,
        [matchId],
      );
      expect(Number(rows[0].amount)).toBe(0);
    });

    it('sweeps the remainder to rake and still empties escrow', async () => {
      const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
      const matchId = uuidv7();
      await Promise.all([fund(alice, 5000), fund(bob, 5000)]);
      await wallet.buyIn({ userId: alice, matchId, amount: 1000 });
      await wallet.buyIn({ userId: bob, matchId, amount: 1000 });

      const result = await wallet.settle({ matchId, payouts: [{ userId: alice, amount: 1900 }] });
      expect(result.rake).toBe(100);

      const { rows } = await pool.query(
        `SELECT b.amount FROM wallet.balances b JOIN wallet.accounts a ON a.id = b.account_id
          WHERE a.match_id = $1`,
        [matchId],
      );
      expect(Number(rows[0].amount)).toBe(0);
    });

    it('settles a match only once, however many times it is retried', async () => {
      const userId = await makeUser();
      const matchId = uuidv7();
      await fund(userId, 5000);
      await wallet.buyIn({ userId, matchId, amount: 1000 });

      await wallet.settle({ matchId, payouts: [{ userId, amount: 1000 }] });
      const retry = await wallet.settle({ matchId, payouts: [{ userId, amount: 1000 }] });

      expect(retry.replayed).toBe(true);
      expect((await wallet.getBalance(userId)).amount).toBe(5000);
    });

    it('refuses to pay out more than the escrow holds', async () => {
      const userId = await makeUser();
      const matchId = uuidv7();
      await fund(userId, 5000);
      await wallet.buyIn({ userId, matchId, amount: 1000 });

      await expect(
        wallet.settle({ matchId, payouts: [{ userId, amount: 999_999 }] }),
      ).rejects.toThrow(/would pay/);
    });
  });

  describe('reversal', () => {
    it('reverses by posting the mirror image, leaving both transactions in place', async () => {
      const userId = await makeUser();
      const funded = await wallet.addFunds({ userId, amount: 3000, idempotencyKey: `rev:${uuidv7()}` });
      expect((await wallet.getBalance(userId)).amount).toBe(3000);

      await wallet.reverse({
        transactionId: funded.transactionId,
        reason: 'test',
        actorId: userId,
        actorType: 'admin',
      });

      expect((await wallet.getBalance(userId)).amount).toBe(0);
      // The original is still there — history is never rewritten (rule 5).
      const { rows } = await pool.query('SELECT id FROM wallet.ledger_transactions WHERE id = $1', [
        funded.transactionId,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('funding gates (ADR-022)', () => {
    it('refuses funding when its own flag is off', async () => {
      const userId = await makeUser();
      await flags.set(FlagKey.DEV_DIRECT_CREDIT, false, 'test');
      try {
        await expect(
          wallet.addFunds({ userId, amount: 1000, idempotencyKey: `off:${uuidv7()}` }),
        ).rejects.toThrow(/not available/);
      } finally {
        await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'test');
      }
    });

    it('REFUSES funding whenever the compliance gate is ON, even with its own flag on', async () => {
      // The invariant of ADR-022: a money-creating path must be unreachable the moment
      // real money is enabled. Both flags on must still mean refused.
      const userId = await makeUser();
      await flags.set(FlagKey.REAL_MONEY_ENABLED, true, 'test');
      try {
        await expect(
          wallet.addFunds({ userId, amount: 1000, idempotencyKey: `gate:${uuidv7()}` }),
        ).rejects.toThrow(/not available/);
      } finally {
        await flags.set(FlagKey.REAL_MONEY_ENABLED, false, 'test');
      }
      expect(await flags.isRealMoneyEnabled()).toBe(false);
    });

    it('enforces the per-request cap', async () => {
      const userId = await makeUser();
      await expect(
        wallet.addFunds({ userId, amount: 999_999_99, idempotencyKey: `cap:${uuidv7()}` }),
      ).rejects.toThrow(/limit/i);
    });
  });

  describe('reconciliation (rule 9)', () => {
    it('reports clean after normal activity', async () => {
      const userId = await makeUser();
      await fund(userId, 5000);
      const matchId = uuidv7();
      await wallet.buyIn({ userId, matchId, amount: 1000 });
      await wallet.settle({ matchId, payouts: [{ userId, amount: 1000 }] });

      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it('DETECTS injected balance-cache drift', async () => {
      const userId = await makeUser();
      await fund(userId, 4000);
      const account = await repository.findUserAccount(userId, TEST_CURRENCY);

      // Corrupt the cache directly — the drift a bug would cause. `balances` is a cache,
      // so it is mutable; the ledger it must agree with is not.
      await pool.query('UPDATE wallet.balances SET amount = amount + 777 WHERE account_id = $1', [
        account!.id,
      ]);

      const report = await reconciliation.run();
      expect(report.ok).toBe(false);
      const finding = report.findings.find((f) => f.subject === account!.id);
      expect(finding?.check).toBe('balance_cache');

      // Restore so later tests start clean.
      await pool.query('UPDATE wallet.balances SET amount = amount - 777 WHERE account_id = $1', [
        account!.id,
      ]);
      expect((await reconciliation.run()).ok).toBe(true);
    });
  });
});
