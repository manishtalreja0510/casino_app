import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { EngineService } from '../../src/game-engine/engine.service';
import { MatchRepository } from '../../src/game-engine/match.repository';
import { RecoveryService } from '../../src/game-engine/recovery.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { TimerService } from '../../src/realtime/timer.service';
import { WalletRepository } from '../../src/wallet/wallet.repository';
import { ReconciliationService } from '../../src/wallet/reconciliation.service';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey, gameEnabledKey } from '../../src/platform/flags/flag-keys';
import { CrashService, CRASH_GAME_CODE } from '../../src/games/crash/crash.service';
import { CRASH_TIMER_ID } from '../../src/games/crash/crash.game';
import {
  commitmentFor,
  crashPointFromSeed,
  msToReach,
  multiplierAtTick,
  payoutFor,
  ticksToReach,
} from '../../src/games/crash/crash.math';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

const MAX = 10_000;
const EDGE_BPS = 300;

const BASE_CONFIG = {
  betMin: 100,
  betMax: 100_000,
  maxRoundStake: 1_000_000,
  maxHouseExposure: 200_000_000,
  bettingWindowMs: 1_000,
  interRoundMs: 60_000,
  houseEdgeBps: EDGE_BPS,
  maxMultiplierX100: MAX,
};

/** A seed whose crash point sits in `[min, max)` — how a test picks the round it wants. */
function seedCrashingBetween(min: number, max: number): string {
  for (let i = 0; i < 500_000; i++) {
    const seed = `int-${i}`;
    const point = crashPointFromSeed(seed, EDGE_BPS, MAX);
    if (point >= min && point < max) return seed;
  }
  throw new Error(`no seed crashing in [${min}, ${max})`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Crash end to end, against real PostgreSQL and Redis.
 *
 * The unit tests prove the arithmetic. These prove the things arithmetic cannot: that
 * money actually lands where the game says it should, that escrow ends empty, that a
 * retried settlement pays once, that a round survives its own process dying, and that the
 * house is the one carrying the risk.
 */
describe('crash (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let engine: EngineService;
  let matches: MatchRepository;
  let recovery: RecoveryService;
  let wallet: WalletService;
  let walletRepo: WalletRepository;
  let reconciliation: ReconciliationService;
  let flags: FlagsService;
  let crash: CrashService;
  let timers: TimerService;

  async function makePlayer(funded = 100_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Crash Test')`,
      [id, `crash-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `crash-seed:${id}` });
    }
    return id;
  }

  /**
   * Waits for a match to reach a status.
   *
   * A round crashes on a server timer, so some transitions happen on the platform's clock
   * rather than on the test's call stack. Polling the database is the honest way to wait
   * for one — asserting immediately would be testing a race.
   */
  async function waitForStatus(matchId: string, status: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = await matches.findMatch(matchId);
      if (match?.status === status) return;
      if (Date.now() > deadline) {
        throw new Error(`match ${matchId} is ${match?.status ?? 'missing'}, expected ${status}`);
      }
      await sleep(50);
    }
  }

  async function balanceOf(userId: string): Promise<number> {
    return (await wallet.getBalance(userId)).amount;
  }

  async function escrowBalance(matchId: string): Promise<number> {
    const { rows } = await pool.query<{ amount: string }>(
      `SELECT COALESCE(b.amount, 0)::text AS amount
         FROM wallet.accounts a
         LEFT JOIN wallet.balances b ON b.account_id = a.id
        WHERE a.match_id = $1`,
      [matchId],
    );
    return Number(rows[0]?.amount ?? 0);
  }

  async function houseBalance(): Promise<number> {
    const { rows } = await pool.query<{ amount: string }>(
      `SELECT COALESCE(b.amount, 0)::text AS amount
         FROM wallet.accounts a
         LEFT JOIN wallet.balances b ON b.account_id = a.id
        WHERE a.type = 'house_main' AND a.currency = 'TST'`,
    );
    return Number(rows[0]?.amount ?? 0);
  }

  /** Opens a round with a chosen outcome and a roster, then lifts off. */
  async function openRound(input: {
    seed: string;
    bets: Array<{ userId: string; stake: number; autoCashOutX100?: number }>;
    config?: Partial<typeof BASE_CONFIG>;
  }): Promise<string> {
    const config = { ...BASE_CONFIG, ...input.config };
    const { matchId } = await engine.createOpenMatch({
      gameCode: CRASH_GAME_CODE,
      stake: input.bets[0]?.stake ?? 0,
      config: {
        ...config,
        tierId: `crash:manual-${uuidv7()}`,
        serverSeed: input.seed,
        commitment: commitmentFor(input.seed),
        betsCloseAt: Date.now() + 60_000,
      },
    });

    for (const bet of input.bets) {
      await engine.joinMatch({
        matchId,
        userId: bet.userId,
        stake: bet.stake,
        meta: bet.autoCashOutX100 === undefined ? {} : { autoCashOutX100: bet.autoCashOutX100 },
      });
    }

    await engine.startMatch(matchId);
    return matchId;
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    engine = app.get(EngineService);
    matches = app.get(MatchRepository);
    recovery = app.get(RecoveryService);
    wallet = app.get(WalletService);
    walletRepo = app.get(WalletRepository);
    reconciliation = app.get(ReconciliationService);
    flags = app.get(FlagsService);
    crash = app.get(CrashService);
    timers = app.get(TimerService);

    // Rounds left in flight by an earlier (possibly failed) run would otherwise be found
    // by `findActiveRound` and make this suite assert against somebody else's round.
    // Voided rather than deleted, so any escrow they hold goes back to its owner.
    const stale = await pool.query<{ id: string }>(
      `SELECT id FROM game.matches
        WHERE game_code = 'crash' AND status IN ('created','starting','in_progress','settling')`,
    );
    for (const row of stale.rows) await engine.voidMatch(row.id, 'integration suite reset');

    // Test players are funded through the interim direct-credit path (ADR-022).
    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
  });

  afterAll(async () => {
    await flags?.set(FlagKey.DEV_DIRECT_CREDIT, false, 'integration-test cleanup');
    await app?.close();
    await pool?.end();
  });

  describe('a round, end to end', () => {
    it('pays a cash-out from escrow and the house, and empties the escrow', async () => {
      // A round that will fly for a while, so a cash-out a few hundred ms in is safely
      // below the crash point.
      const seed = seedCrashingBetween(500, 2_000);
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      const stake = 10_000;

      const before = { alice: await balanceOf(alice), bob: await balanceOf(bob), house: await houseBalance() };

      const matchId = await openRound({ seed, bets: [{ userId: alice, stake }, { userId: bob, stake }] });

      // Both stakes are in escrow the moment the bets are taken — not at settlement.
      expect(await escrowBalance(matchId)).toBe(stake * 2);
      expect(await balanceOf(alice)).toBe(before.alice - stake);

      await sleep(350);
      const cashOut = await crash.cashOut(alice, matchId);
      expect(cashOut.cashedOutAtX100).toBeGreaterThan(100);
      expect(cashOut.payout).toBe(payoutFor(stake, cashOut.cashedOutAtX100));

      // Fire the crash the moment the test wants it, rather than waiting out the flight.
      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      await waitForStatus(matchId, 'settled');
      expect(await escrowBalance(matchId)).toBe(0);

      expect(await balanceOf(alice)).toBe(before.alice - stake + cashOut.payout);
      // Bob rode past the crash: his stake is gone, and it is the house that has it.
      expect(await balanceOf(bob)).toBe(before.bob - stake);
      expect(await houseBalance()).toBe(before.house + stake * 2 - cashOut.payout);
    });

    it('pays a winner more than the pot — the house carries it', async () => {
      const seed = seedCrashingBetween(2_000, MAX);
      const alice = await makePlayer();
      const stake = 10_000;
      const houseBefore = await houseBalance();

      const matchId = await openRound({ seed, bets: [{ userId: alice, stake, autoCashOutX100: 1_500 }] });

      // The auto target is honoured without the player doing anything at all.
      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      const balance = await balanceOf(alice);
      // The target is a *floor*: the curve moves in whole ticks, so the player locks in
      // the first tick at or above 15.00x, not 15.00x exactly.
      const locked = multiplierAtTick(ticksToReach(1_500, MAX), MAX);
      expect(locked).toBeGreaterThanOrEqual(1_500);
      const payout = payoutFor(stake, locked);

      expect(payout).toBeGreaterThan(stake);
      expect(balance).toBe(100_000 - stake + payout);
      // The pot was one stake; the house paid the rest.
      expect(await houseBalance()).toBe(houseBefore + stake - payout);
      expect(await houseBalance()).toBeLessThan(houseBefore);
      expect(await escrowBalance(matchId)).toBe(0);
    });

    it('keeps every stake when the round busts instantly', async () => {
      const seed = seedCrashingBetween(100, 101);
      const alice = await makePlayer();
      const stake = 5_000;
      const houseBefore = await houseBalance();

      const matchId = await openRound({ seed, bets: [{ userId: alice, stake }] });

      // 1.00x: there is no moment at which cashing out is possible.
      await expect(crash.cashOut(alice, matchId)).rejects.toThrow();

      // The crash deadline was armed at zero delay, so the round ends on the platform's
      // own timer rather than on this test's call stack.
      await waitForStatus(matchId, 'settled');
      expect(await balanceOf(alice)).toBe(100_000 - stake);
      expect(await houseBalance()).toBe(houseBefore + stake);
    });

    it('settles a free-play round without touching the ledger', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const alice = await makePlayer(0);
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 0 }] });

      await sleep(250);
      await crash.cashOut(alice, matchId);
      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      await waitForStatus(matchId, 'settled');
      expect(await balanceOf(alice)).toBe(0);

      const { rows } = await pool.query(
        `SELECT 1 FROM wallet.ledger_transactions WHERE ref_id = $1`,
        [matchId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('the things a client must not be able to do', () => {
    it('refuses a cash-out once the curve passed the crash point, timer or no timer', async () => {
      // A round that crashes almost immediately, so the window between "crashed" and
      // "timer fired" can be entered deliberately.
      const seed = seedCrashingBetween(101, 110);
      const alice = await makePlayer();
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 1_000 }] });

      // Cancel the crash deadline, which is exactly the situation being tested: a timer
      // that is late, lost, or stuck behind a slow event loop. The refusal must come from
      // the reducer's own arithmetic, not from the timer having fired.
      timers.cancel(`${matchId}:${CRASH_TIMER_ID}`);

      const crashPoint = crashPointFromSeed(seed, EDGE_BPS, MAX);
      await sleep(msToReach(crashPoint, MAX) + 150);

      // The match is still `in_progress` — nothing has fired the crash yet.
      expect((await matches.findMatch(matchId))?.status).toBe('in_progress');
      await expect(crash.cashOut(alice, matchId)).rejects.toThrow(/crash/i);

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);
      expect(await balanceOf(alice)).toBe(100_000 - 1_000);
    });

    it('refuses a cash-out from someone who did not bet, and a second from someone who did', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const [alice, mallory] = await Promise.all([makePlayer(), makePlayer()]);
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 1_000 }] });

      await expect(crash.cashOut(mallory, matchId)).rejects.toThrow();
      await sleep(250);
      await crash.cashOut(alice, matchId);
      await expect(crash.cashOut(alice, matchId)).rejects.toThrow(/already/i);

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);
    });

    it('never puts the seed or the crash point in a view before the round ends', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const alice = await makePlayer();
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 1_000 }] });

      const flying = await engine.viewFor(matchId, alice);
      expect(JSON.stringify(flying)).not.toContain(seed);
      expect((flying.view as Record<string, unknown>).crashedAtX100).toBeNull();

      const publicFlying = await engine.publicViewFor(matchId);
      expect(JSON.stringify(publicFlying)).not.toContain(seed);

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      // And afterwards it is revealed, which is what makes the round checkable.
      const settled = await engine.publicViewFor(matchId);
      expect(settled?.serverSeed).toBe(seed);
      expect(commitmentFor(settled?.serverSeed as string)).toBe(settled?.commitment);
      expect(settled?.crashedAtX100).toBe(crashPointFromSeed(seed, EDGE_BPS, MAX));
    });
  });

  describe('settlement discipline', () => {
    it('pays once, however many times settlement is retried', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const alice = await makePlayer();
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 4_000 }] });

      await sleep(250);
      await crash.cashOut(alice, matchId);
      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      const afterFirst = await balanceOf(alice);
      const houseAfterFirst = await houseBalance();

      await engine.settle(matchId);
      await engine.settle(matchId);

      expect(await balanceOf(alice)).toBe(afterFirst);
      expect(await houseBalance()).toBe(houseAfterFirst);
    });

    it('leaves the ledger reconciled', async () => {
      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  describe('surviving a restart', () => {
    it('replays a clock-dependent round exactly, and re-arms what is left of the flight', async () => {
      const seed = seedCrashingBetween(1_000, MAX);
      const alice = await makePlayer();
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 2_000 }] });

      await sleep(250);
      await crash.cashOut(alice, matchId);

      // The whole point of recording the clock: without it, replaying this round would
      // price the cash-out at whatever time the replay ran.
      const verification = await engine.replayAndVerify(matchId);
      expect(verification).toEqual({ ok: true });

      const outcome = await recovery.recover(matchId);
      expect(outcome.action).toBe('resumed');
      expect((await matches.findMatch(matchId))?.status).toBe('in_progress');

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);
      await waitForStatus(matchId, 'settled');
    });

    it('finishes a round that crashed before its settlement was written', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const alice = await makePlayer();
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 3_000 }] });

      await sleep(250);
      await crash.cashOut(alice, matchId);

      // Simulate dying between deciding the outcome and paying it.
      await pool.query(`UPDATE game.matches SET status = 'settling' WHERE id = $1`, [matchId]);
      const outcome = await recovery.recover(matchId);

      expect(outcome.action).toBe('settled');
      expect(await escrowBalance(matchId)).toBe(0);
    });
  });

  describe('the round loop', () => {
    const tierId = 'crash:int-loop';

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config)
         VALUES ($1, 'crash', 'Integration', 1000, 99, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
        [tierId, JSON.stringify({ ...BASE_CONFIG, betMin: 1_000, betMax: 20_000, interRoundMs: 60_000 })],
      );
    });

    afterAll(async () => {
      await pool.query(`UPDATE game.stake_tiers SET enabled = false WHERE id = $1`, [tierId]);
    });

    it('opens a round, takes bets into it, and reports it honestly', async () => {
      await crash.sweep();

      const round = await crash.roundFor(tierId);
      expect(round.phase).toBe('betting');
      expect(round.matchId).not.toBe('');
      expect(round.commitment).toHaveLength(64);
      expect(round.serverSeed).toBeNull();
      expect(round.betsCloseAt).toBeGreaterThan(Date.now() - BASE_CONFIG.bettingWindowMs);

      const alice = await makePlayer();
      const bet = await crash.placeBet({ userId: alice, tierId, amount: 5_000 });

      expect(bet.matchId).toBe(round.matchId);
      expect(bet.balance).toBe(95_000);
      expect((await crash.roundFor(tierId)).bets).toHaveLength(1);

      // The window closes on its own, and the round lifts off with whoever bet.
      await waitForStatus(round.matchId, 'in_progress');
      const flying = await crash.roundFor(tierId);
      expect(flying.matchId).toBe(round.matchId);
      expect(flying.phase).toBe('flying');
      expect(flying.startedAt).not.toBeNull();

      await engine.handleTimeout(flying.matchId, CRASH_TIMER_ID);
      await waitForStatus(flying.matchId, 'settled');
    });

    it('voids a round nobody bet in, without a ledger entry', async () => {
      await crash.sweep();
      const round = await crash.roundFor(tierId);
      expect(round.phase).toBe('betting');

      await waitForStatus(round.matchId, 'voided');

      const match = await matches.findMatch(round.matchId);
      expect(match?.status).toBe('voided');
      expect(match?.voidReason).toBe('no bets placed');

      const { rows } = await pool.query(`SELECT 1 FROM wallet.ledger_transactions WHERE ref_id = $1`, [
        round.matchId,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('refuses a bet outside the tier bounds', async () => {
      await crash.sweep();
      const alice = await makePlayer();

      await expect(crash.placeBet({ userId: alice, tierId, amount: 1 })).rejects.toThrow(/between/i);
      await expect(crash.placeBet({ userId: alice, tierId, amount: 999_999 })).rejects.toThrow(/between/i);
      await expect(
        crash.placeBet({ userId: alice, tierId, amount: 5_000, autoCashOutX100: 100 }),
      ).rejects.toThrow(/Auto cash-out/i);

      expect(await balanceOf(alice)).toBe(100_000);
    });

    it('refuses a bet that would take the round past its stake cap', async () => {
      const cappedTier = 'crash:int-cap';
      await pool.query(
        `INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config)
         VALUES ($1, 'crash', 'Capped', 1000, 98, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
        [
          cappedTier,
          JSON.stringify({ ...BASE_CONFIG, betMin: 1_000, betMax: 10_000, maxRoundStake: 12_000, bettingWindowMs: 30_000 }),
        ],
      );

      await crash.sweep();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);

      await crash.placeBet({ userId: alice, tierId: cappedTier, amount: 10_000 });
      // 10_000 + 10_000 > 12_000: refused, and nothing was taken.
      await expect(
        crash.placeBet({ userId: bob, tierId: cappedTier, amount: 10_000 }),
      ).rejects.toThrow(/maximum stake/i);
      expect(await balanceOf(bob)).toBe(100_000);

      // …and a bet that fits is still accepted, so the cap refuses rather than closes.
      await crash.placeBet({ userId: bob, tierId: cappedTier, amount: 2_000 });
      expect(await balanceOf(bob)).toBe(98_000);

      const round = await crash.roundFor(cappedTier);
      await engine.voidMatch(round.matchId, 'test cleanup');
      await pool.query(`UPDATE game.stake_tiers SET enabled = false WHERE id = $1`, [cappedTier]);
    });

    it('refuses a bet that would put the house past its exposure limit', async () => {
      const exposedTier = 'crash:int-exposure';
      await pool.query(
        `INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config)
         VALUES ($1, 'crash', 'Exposed', 1000, 97, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
        [
          exposedTier,
          JSON.stringify({
            ...BASE_CONFIG,
            betMin: 1_000,
            betMax: 10_000,
            maxRoundStake: 1_000_000,
            // A 100x cap on a 5_000 stake is 495_000 of exposure beyond escrow.
            maxHouseExposure: 400_000,
            bettingWindowMs: 30_000,
          }),
        ],
      );

      await crash.sweep();
      const alice = await makePlayer();

      await expect(
        crash.placeBet({ userId: alice, tierId: exposedTier, amount: 5_000 }),
      ).rejects.toThrow(/table limit/i);
      expect(await balanceOf(alice)).toBe(100_000);

      const round = await crash.roundFor(exposedTier);
      if (round.matchId) await engine.voidMatch(round.matchId, 'test cleanup');
      await pool.query(`UPDATE game.stake_tiers SET enabled = false WHERE id = $1`, [exposedTier]);
    });
  });

  describe('the kill-switch', () => {
    const tierId = 'crash:int-kill';

    it('drains: the open round finishes, no new bets are taken, no new round opens', async () => {
      await pool.query(
        `INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config)
         VALUES ($1, 'crash', 'Kill', 1000, 96, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
        [tierId, JSON.stringify({ ...BASE_CONFIG, betMin: 1_000, betMax: 20_000, bettingWindowMs: 30_000 })],
      );

      await crash.sweep();
      const alice = await makePlayer();
      const round = await crash.roundFor(tierId);
      await crash.placeBet({ userId: alice, tierId, amount: 5_000 });

      await flags.set(gameEnabledKey(CRASH_GAME_CODE), false, 'integration test');
      try {
        // No new bets into the disabled game…
        const bob = await makePlayer();
        await expect(crash.placeBet({ userId: bob, tierId, amount: 5_000 })).rejects.toThrow();

        // …and no new rounds. But the open one is untouched: its escrow is still there.
        await crash.sweep();
        expect(await escrowBalance(round.matchId)).toBe(5_000);

        // The in-flight round completes normally, which is what "drain" means: pulling
        // the switch never strands a stake.
        await engine.startMatch(round.matchId);
        await engine.handleTimeout(round.matchId, CRASH_TIMER_ID);

        // Waited for, not asserted immediately: the round's own crash timer was armed at
        // lift-off and may fire concurrently with this manual one. Whichever wins settles
        // the round, and the loser correctly does nothing — so the test must wait for the
        // outcome rather than assume it happened on its own call stack.
        await waitForStatus(round.matchId, 'settled');
        expect(await escrowBalance(round.matchId)).toBe(0);
      } finally {
        await flags.set(gameEnabledKey(CRASH_GAME_CODE), true, 'integration test cleanup');
        await pool.query(`UPDATE game.stake_tiers SET enabled = false WHERE id = $1`, [tierId]);
      }
    });
  });

  describe('open-roster admission (ADR-023)', () => {
    it("does not let one player's bounced bet cancel everyone else's", async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const [rich, broke] = await Promise.all([makePlayer(50_000), makePlayer(0)]);

      const { matchId } = await engine.createOpenMatch({
        gameCode: CRASH_GAME_CODE,
        stake: 10_000,
        config: {
          ...BASE_CONFIG,
          tierId: `crash:manual-${uuidv7()}`,
          serverSeed: seed,
          commitment: commitmentFor(seed),
          betsCloseAt: Date.now() + 60_000,
        },
      });

      await engine.joinMatch({ matchId, userId: rich, stake: 10_000 });
      await expect(
        engine.joinMatch({ matchId, userId: broke, stake: 10_000 }),
      ).rejects.toThrow(/funds/i);

      // This is the difference from a matchmade formation, which would have rolled the
      // whole thing back.
      expect(await escrowBalance(matchId)).toBe(10_000);
      expect(await balanceOf(rich)).toBe(40_000);
      expect(await matches.listPlayers(matchId)).toHaveLength(1);

      const started = await engine.startMatch(matchId);
      expect(started).toEqual({ started: true, players: 1 });

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);
    });

    it('charges a bet exactly once when it is retried', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const alice = await makePlayer();
      const { matchId } = await engine.createOpenMatch({
        gameCode: CRASH_GAME_CODE,
        stake: 5_000,
        config: {
          ...BASE_CONFIG,
          tierId: `crash:manual-${uuidv7()}`,
          serverSeed: seed,
          commitment: commitmentFor(seed),
          betsCloseAt: Date.now() + 60_000,
        },
      });

      await engine.joinMatch({ matchId, userId: alice, stake: 5_000 });
      await expect(engine.joinMatch({ matchId, userId: alice, stake: 5_000 })).rejects.toThrow(
        /already joined/i,
      );

      expect(await balanceOf(alice)).toBe(95_000);
      expect(await escrowBalance(matchId)).toBe(5_000);

      await engine.voidMatch(matchId, 'test cleanup');
      expect(await balanceOf(alice)).toBe(100_000);
    });

    it('refuses to open a matchmade game as an open round', async () => {
      await expect(
        engine.createOpenMatch({ gameCode: 'coin-duel', stake: 0 }),
      ).rejects.toThrow(/not a round-based game/i);
    });

    it('refuses a bet once betting has closed', async () => {
      const seed = seedCrashingBetween(500, 2_000);
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      const matchId = await openRound({ seed, bets: [{ userId: alice, stake: 1_000 }] });

      await expect(engine.joinMatch({ matchId, userId: bob, stake: 1_000 })).rejects.toThrow();
      expect(await balanceOf(bob)).toBe(100_000);

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);
    });
  });

  describe('house-banked settlement (ADR-024)', () => {
    it('lets the house float go negative — it is the only account that may', async () => {
      const house = await walletRepo.findUserAccount('00000000-0000-0000-0000-000000000000', 'TST');
      expect(house).toBeNull(); // sanity: no user account masquerading as the house

      const seed = seedCrashingBetween(5_000, MAX);
      const alice = await makePlayer();
      const matchId = await openRound({
        seed,
        bets: [{ userId: alice, stake: 100_000, autoCashOutX100: 5_000 }],
        config: { betMax: 100_000, maxRoundStake: 1_000_000 },
      });

      await engine.handleTimeout(matchId, CRASH_TIMER_ID);

      // ~50x on 100_000 is ~5_000_000 paid out against 100_000 of escrow.
      const locked = multiplierAtTick(ticksToReach(5_000, MAX), MAX);
      expect(await balanceOf(alice)).toBe(payoutFor(100_000, locked));
      expect(await houseBalance()).toBeLessThan(0);
      expect(await escrowBalance(matchId)).toBe(0);
    });

    it('still reconciles once the house has been through both', async () => {
      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });
});
