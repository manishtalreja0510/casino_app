import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { WalletService } from '../../src/wallet/wallet.service';
import { RgService } from '../../src/responsible-gaming/rg.service';
import { RgRepository } from '../../src/responsible-gaming/rg.repository';
import { MatchmakingService } from '../../src/matchmaking/matchmaking.service';
import { PokerService } from '../../src/games/poker/poker.service';
import { PokerRepository } from '../../src/games/poker/poker.repository';
import { AuthService } from '../../src/auth/auth.service';
import { AuthRepository } from '../../src/auth/auth.repository';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { PresenceService } from '../../src/realtime/presence.service';
import { Rooms } from '../../src/realtime/realtime.types';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { withTransaction } from '../../src/platform/database/transaction';
import { ensureMigrated, testPool } from './db';

/**
 * Responsible gaming end to end.
 *
 * The acceptance criteria for this phase are all here, and they are all of the same shape:
 * a block a player asked for must bind on **every** path, within one action, without any
 * game having been told about it.
 */
describe('responsible gaming (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let rg: RgService;
  let rgRepo: RgRepository;
  let wallet: WalletService;
  let matchmaking: MatchmakingService;
  let poker: PokerService;
  let tables: PokerRepository;
  let accounts: AuthRepository;
  let flags: FlagsService;
  let realtime: RealtimeService;
  let presence: PresenceService;

  async function makePlayer(funded = 100_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'RG Test')`,
      [id, `rg-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `rg-seed:${id}` });
    }
    return id;
  }

  const statusOf = async (userId: string) => (await accounts.findUserById(userId))?.status;

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    rg = app.get(RgService);
    rgRepo = app.get(RgRepository);
    wallet = app.get(WalletService);
    matchmaking = app.get(MatchmakingService);
    poker = app.get(PokerService);
    tables = app.get(PokerRepository);
    accounts = app.get(AuthRepository);
    flags = app.get(FlagsService);
    realtime = app.get(RealtimeService);
    presence = app.get(PresenceService);

    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
  }, 60_000);

  afterAll(async () => {
    await flags?.set(FlagKey.DEV_DIRECT_CREDIT, false, 'cleanup');
    await app?.close();
    await pool?.end();
  });

  describe('limits', () => {
    it('binds a decrease immediately', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 5_000 });

      // Under the limit: fine.
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 4_000 }),
      ).resolves.toBeDefined();

      // Over what remains: refused, and nothing moved.
      const before = (await wallet.getBalance(alice)).amount;
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 2_000 }),
      ).rejects.toThrow(/limit/i);
      expect((await wallet.getBalance(alice)).amount).toBe(before);
    });

    it('holds an increase for its cooling period, and keeps enforcing the old one meanwhile', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 1_000 });

      const raise = await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 90_000 });
      expect(raise.effective).toBe('pending');
      expect(raise.effectiveAt!.getTime()).toBeGreaterThan(Date.now());

      // The looser number is requested, not in force. This is the whole mechanism: a player
      // who wants more room has to still want it tomorrow.
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 5_000 }),
      ).rejects.toThrow(/limit/i);
    });

    it('applies a pending increase once its time comes, without a sweep', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 1_000 });
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 50_000 });

      // Bring the cooling period forward, as the passage of a day would.
      await pool.query(
        `UPDATE rg.limits SET pending_effective_at = now() - interval '1 minute'
          WHERE user_id = $1 AND type = 'wager' AND period = 'day'`,
        [alice],
      );

      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 5_000 }),
      ).resolves.toBeDefined();
    });

    it('lets a player cancel an increase they thought better of', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 1_000 });
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 50_000 });
      await rg.cancelPendingIncrease(alice, 'wager', 'day');

      const status = (await rg.statusFor(alice)) as { limits: Array<{ pendingAmount: number | null }> };
      expect(status.limits[0]!.pendingAmount).toBeNull();
    });

    it('counts a loss limit net of winnings', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'loss', period: 'day', amount: 10_000 });

      const matchId = uuidv7();
      await wallet.buyIn({ userId: alice, matchId, amount: 8_000 });
      // Won most of it back: the loss is 1,000, not 8,000.
      await wallet.settle({ matchId, payouts: [{ userId: alice, amount: 7_000 }] });

      // So there is room for another 9,000 of losses.
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 8_000 }),
      ).resolves.toBeDefined();
    });

    it('limits the faucet through the deposit limit', async () => {
      const alice = await makePlayer(0);
      await rg.setLimit({ userId: alice, type: 'deposit', period: 'day', amount: 5_000 });

      await expect(
        wallet.addFunds({ userId: alice, amount: 4_000, idempotencyKey: uuidv7() }),
      ).resolves.toBeDefined();
      await expect(
        wallet.addFunds({ userId: alice, amount: 4_000, idempotencyKey: uuidv7() }),
      ).rejects.toThrow(/limit/i);
    });

    it('does not meter a replayed operation twice', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 10_000 });

      const matchId = uuidv7();
      await wallet.buyIn({ userId: alice, matchId, amount: 6_000 });
      // The same buy-in again: idempotent, charges nothing — so it must consume no
      // allowance either, or a retry would eat a limit it never spent.
      await wallet.buyIn({ userId: alice, matchId, amount: 6_000 });

      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 4_000 }),
      ).resolves.toBeDefined();
    });
  });

  describe('self-exclusion', () => {
    it('blocks funding, staking, queueing and sitting down — within one action', async () => {
      const alice = await makePlayer();
      const tableId = await tables.createTable({
        tierId: 'poker:micro',
        name: 'RG Test',
        seatCount: 6,
        currency: 'TST',
        config: {
          blinds: { sb: 100, bb: 200 },
          buyIn: { min: 8_000, max: 20_000 },
          turnTimerMs: 15_000,
          timebankMs: 0,
          timebankStepMs: 10_000,
          rake: { bps: 0, cap: 0 },
          buttonOrder: 0,
          muckLosers: true,
        },
      });

      await rg.exclude({ userId: alice, kind: 'self_exclusion', durationMs: null });

      await expect(
        wallet.addFunds({ userId: alice, amount: 1_000, idempotencyKey: uuidv7() }),
      ).rejects.toThrow(/excluded/i);
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 1_000 }),
      ).rejects.toThrow(/excluded/i);
      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).rejects.toThrow(/excluded/i);
      await expect(poker.sit({ userId: alice, tableId, buyIn: 10_000 })).rejects.toThrow(/excluded/i);
    });

    it('moves the account state in the same breath', async () => {
      const alice = await makePlayer();
      expect(await statusOf(alice)).toBe('active');

      await rg.exclude({ userId: alice, kind: 'cool_off', durationMs: 60 * 60 * 1000 });
      expect(await statusOf(alice)).toBe('self_excluded');
    });

    it('still lets an excluded player sign in, so they can see it and reach support', async () => {
      // The opposite of what P3 did, and deliberately: an exclusion a player cannot look
      // at is a support ticket waiting to happen. Nothing is unlocked by letting them in —
      // every money path above still refuses.
      expect(() => AuthService.assertUsable({ status: 'self_excluded' })).not.toThrow();
      expect(() => AuthService.assertUsable({ status: 'suspended' })).toThrow();
      expect(() => AuthService.assertUsable({ status: 'closed' })).toThrow();
    });

    it('cannot be shortened or deleted, by anyone', async () => {
      const alice = await makePlayer();
      await rg.exclude({ userId: alice, kind: 'cool_off', durationMs: 7 * 24 * 60 * 60 * 1000 });

      const exclusion = (await rgRepo.activeExclusion(alice))!;

      // The database refuses, not the service — "we would never do that" is not a control.
      await expect(
        pool.query(`UPDATE rg.exclusions SET ends_at = now() WHERE id = $1`, [exclusion.id]),
      ).rejects.toThrow(/shortened/i);
      await expect(
        pool.query(`DELETE FROM rg.exclusions WHERE id = $1`, [exclusion.id]),
      ).rejects.toThrow(/cannot be deleted/i);
    });

    it('refuses to put an end date on a permanent exclusion', async () => {
      const alice = await makePlayer();
      await rg.exclude({ userId: alice, kind: 'self_exclusion', durationMs: null });
      const exclusion = (await rgRepo.activeExclusion(alice))!;

      await expect(
        pool.query(`UPDATE rg.exclusions SET ends_at = now() + interval '1 day' WHERE id = $1`, [
          exclusion.id,
        ]),
      ).rejects.toThrow(/permanent/i);
    });

    it('lets a cool-off lapse on its own, and gives the account back', async () => {
      const alice = await makePlayer();
      // A cool-off that really only lasts a second, rather than a long one whose end date
      // is then dragged backwards: the trigger above refuses that, correctly. An exclusion
      // cannot be shortened by anyone, and a test is not an exception to the control the
      // whole feature rests on — so this waits the second out instead.
      await rg.exclude({ userId: alice, kind: 'cool_off', durationMs: 1_000 });
      expect(await rg.isExcluded(alice)).toBe(true);
      expect(await statusOf(alice)).toBe('self_excluded');

      await new Promise((resolve) => setTimeout(resolve, 1_200));

      // Enforcement stops the moment the end date passes — it reads the row, not a flag.
      expect(await rg.isExcluded(alice)).toBe(false);
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 1_000 }),
      ).resolves.toBeDefined();

      // And the account stops *saying* it is excluded. Nothing revisits a lapsed break on
      // its own, so a sweep does; without it a week off was a permanent label.
      expect(await rg.releaseLapsedExclusions()).toContain(alice);
      expect(await statusOf(alice)).toBe('active');
    });

    it('refuses a permanent cool-off — that is what self-exclusion is', async () => {
      const alice = await makePlayer();
      await expect(
        rg.exclude({ userId: alice, kind: 'cool_off', durationMs: null }),
      ).rejects.toThrow(/permanent/i);
    });
  });

  describe('time played', () => {
    it('meters a minute for whoever is connected, and nobody else', async () => {
      const playing = await makePlayer();
      const away = await makePlayer();
      await presence.join(Rooms.user(playing), playing, `socket-${uuidv7()}`);

      const metered = await rg.meterConnectedPlayTime();
      expect(metered).toBeGreaterThan(0);

      const { rows } = await pool.query(
        `SELECT user_id, spent FROM rg.limit_usage
          WHERE type = 'session_time' AND period = 'day' AND user_id = ANY($1::uuid[])`,
        [[playing, away]],
      );
      const byUser = Object.fromEntries(rows.map((row) => [row.user_id, Number(row.spent)]));
      expect(byUser[playing]).toBe(1);
      // Signed in is not playing: a player reading their wallet holds no socket, and their
      // time limit should not run down while they are not at a table.
      expect(byUser[away]).toBeUndefined();

      await presence.leave(Rooms.user(playing), `socket-${playing}`);
    });

    it('stops new play once the limit is spent, without ending a hand', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'session_time', period: 'day', amount: 2 });

      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).resolves.toBeDefined();
      await matchmaking.leaveQueue(alice, 'coin-duel:micro');

      // Two minutes played, as the sweep would have counted them.
      await withTransaction(pool, (client) =>
        rgRepo.meter(client, {
          userId: alice,
          type: 'session_time',
          period: 'day',
          at: new Date(),
          spent: 2,
        }),
      );

      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).rejects.toThrow(
        /time limit of 2 minutes/i,
      );

      // But money already committed still settles: a time limit ends sessions, it does not
      // confiscate a pot (`responsible-gaming.md §3`).
      await expect(
        wallet.settle({
          matchId: uuidv7(),
          payouts: [{ userId: alice, amount: 0 }],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('reality checks', () => {
    it('pauses new play until acknowledged, and never mid-hand', async () => {
      const alice = await makePlayer();
      await rg.setRealityCheckInterval(alice, 5 * 60 * 1000);
      await rg.markRealityCheckShown(alice);

      // Inside the grace period play continues — a player mid-hand is not interrupted.
      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).resolves.toBeDefined();
      await matchmaking.leaveQueue(alice, 'coin-duel:micro');

      // Past it, new play waits for a tap.
      await pool.query(
        `UPDATE rg.reality_check_prefs SET last_shown_at = now() - interval '5 minutes'
          WHERE user_id = $1`,
        [alice],
      );
      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).rejects.toThrow(/reality check/i);

      await rg.acknowledgeRealityCheck(alice);
      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).resolves.toBeDefined();
      await matchmaking.leaveQueue(alice, 'coin-duel:micro');
    });

    it('is pushed by the server to a player who is there to see it', async () => {
      const alice = await makePlayer();
      await rg.setRealityCheckInterval(alice, 5 * 60 * 1000);
      await presence.join(Rooms.user(alice), alice, `socket-${uuidv7()}`);

      const sent = jest.spyOn(realtime, 'toUser').mockResolvedValue({} as never);
      try {
        expect(await rg.dispatchRealityChecks()).toContain(alice);

        const [userId, type, payload] = sent.mock.calls.find((call) => call[0] === alice)!;
        expect(userId).toBe(alice);
        expect(type).toBe('rg:reality_check');
        // It tells the player where they stand, rather than asking the client what it
        // thinks — a client that keeps its own count can decide not to.
        expect(payload).toMatchObject({ intervalMs: 5 * 60 * 1000 });
        expect(payload).toHaveProperty('staked');
        expect(payload).toHaveProperty('net');

        // And it is not sent again while it stands unacknowledged: a second one would only
        // push the grace period back for a player who is ignoring the first.
        sent.mockClear();
        expect(await rg.dispatchRealityChecks()).not.toContain(alice);

        // Acknowledged and due again: a new one.
        await rg.acknowledgeRealityCheck(alice);
        await pool.query(
          `UPDATE rg.reality_check_prefs SET last_shown_at = now() - interval '10 minutes',
                  last_ack_at = now() - interval '10 minutes' WHERE user_id = $1`,
          [alice],
        );
        expect(await rg.dispatchRealityChecks()).toContain(alice);
      } finally {
        sent.mockRestore();
        await presence.leave(Rooms.user(alice), `socket-${alice}`);
      }
    });

    it('is not marked shown for a player who was never sent it', async () => {
      const alice = await makePlayer();
      await rg.setRealityCheckInterval(alice, 5 * 60 * 1000);
      // Nobody connected: no presence entry for this user.

      const sent = jest.spyOn(realtime, 'toUser').mockResolvedValue({} as never);
      try {
        expect(await rg.dispatchRealityChecks()).not.toContain(alice);
        expect(sent.mock.calls.some((call) => call[0] === alice)).toBe(false);
      } finally {
        sent.mockRestore();
      }

      // The important half: marking it shown would start the grace period, and the player
      // would come back to a block for a message that was never sent to them.
      const { rows } = await pool.query(
        `SELECT last_shown_at FROM rg.reality_check_prefs WHERE user_id = $1`,
        [alice],
      );
      expect(rows[0].last_shown_at).toBeNull();
      await expect(matchmaking.joinQueue(alice, 'coin-duel:micro')).resolves.toBeDefined();
      await matchmaking.leaveQueue(alice, 'coin-duel:micro');
    });

    it('does not block spending — only entering play', async () => {
      const alice = await makePlayer();
      await rg.markRealityCheckShown(alice);
      await pool.query(
        `UPDATE rg.reality_check_prefs SET last_shown_at = now() - interval '5 minutes'
          WHERE user_id = $1`,
        [alice],
      );

      // A hand already under way settles and pays normally; the check gates new entries.
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 1_000 }),
      ).resolves.toBeDefined();
    });

    it('refuses an interval outside the allowed band', async () => {
      const alice = await makePlayer();
      await expect(rg.setRealityCheckInterval(alice, 1_000)).rejects.toThrow(/between/i);
      await expect(rg.setRealityCheckInterval(alice, 99 * 60 * 60 * 1000)).rejects.toThrow(/between/i);
    });
  });

  describe('the player’s own view', () => {
    it('shows limits with usage, the exclusion, and a history', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 20_000 });
      await wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 7_000 });

      const status = (await rg.statusFor(alice)) as {
        limits: Array<{ type: string; amount: number; used: number }>;
        exclusion: unknown;
        events: Array<{ type: string }>;
      };

      const wager = status.limits.find((limit) => limit.type === 'wager')!;
      expect(wager.amount).toBe(20_000);
      expect(wager.used).toBe(7_000);
      expect(status.exclusion).toBeNull();
      expect(status.events.some((event) => event.type === 'limit.set')).toBe(true);
    });
  });

  describe('the invariant', () => {
    it('meters every wager path, whichever module asked', async () => {
      const alice = await makePlayer();
      await rg.setLimit({ userId: alice, type: 'wager', period: 'day', amount: 30_000 });

      // A match buy-in and a poker sit-down are different modules, different tables and
      // different escrows — and both are metered, because the check is at the money rather
      // than at the caller (ADR-026).
      await wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 10_000 });
      await wallet.sitDown({
        userId: alice,
        tableId: uuidv7(),
        seatSessionId: uuidv7(),
        amount: 10_000,
      });

      await withTransaction(pool, async (client) => {
        const usage = await rgRepo.usageFor(client, alice, 'wager', 'day', new Date());
        expect(usage.spent).toBe(20_000);
      });
    });
  });
});
