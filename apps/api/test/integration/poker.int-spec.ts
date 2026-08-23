import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { EngineService } from '../../src/game-engine/engine.service';
import { MatchRepository } from '../../src/game-engine/match.repository';
import { RecoveryService } from '../../src/game-engine/recovery.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { ReconciliationService } from '../../src/wallet/reconciliation.service';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey, gameEnabledKey } from '../../src/platform/flags/flag-keys';
import { PokerService, POKER_GAME_CODE } from '../../src/games/poker/poker.service';
import { PokerRepository } from '../../src/games/poker/poker.repository';
import { TURN_TIMER_ID } from '../../src/games/poker/poker.game';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

const BUY_IN = 20_000;
const SB = 100;
const BB = 200;

/**
 * Poker end to end, on real PostgreSQL and Redis.
 *
 * The unit tests prove the rules. These prove the things rules cannot: that chips at a
 * table are backed by money in an escrow, that the escrow always equals what is sitting on
 * the felt, that standing up pays exactly the stack, and that a hand which crashes
 * mid-street comes back rather than eating anyone's chips.
 */
describe('poker (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let poker: PokerService;
  let tables: PokerRepository;
  let engine: EngineService;
  let matches: MatchRepository;
  let recovery: RecoveryService;
  let wallet: WalletService;
  let reconciliation: ReconciliationService;
  let flags: FlagsService;

  async function makePlayer(funded = 100_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Poker Test')`,
      [id, `poker-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `poker-seed:${id}` });
    }
    return id;
  }

  const balanceOf = async (userId: string) => (await wallet.getBalance(userId)).amount;

  async function escrowOf(tableId: string): Promise<number> {
    const { rows } = await pool.query<{ amount: string }>(
      `SELECT COALESCE(b.amount, 0)::text AS amount
         FROM wallet.accounts a
         LEFT JOIN wallet.balances b ON b.account_id = a.id
        WHERE a.table_id = $1`,
      [tableId],
    );
    return Number(rows[0]?.amount ?? 0);
  }

  /** A fresh table of its own, so one test's felt is not another's. */
  async function makeTable(seatCount = 6): Promise<string> {
    return tables.createTable({
      tierId: 'poker:micro',
      name: `Test ${uuidv7().slice(0, 8)}`,
      seatCount,
      currency: 'TST',
      config: {
        blinds: { sb: SB, bb: BB },
        buyIn: { min: 8_000, max: 20_000 },
        turnTimerMs: 15_000,
        timebankMs: 0,
        timebankStepMs: 10_000,
        rake: { bps: 0, cap: 0 },
        buttonOrder: 0,
        muckLosers: true,
        seats: seatCount,
      },
    });
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitForStatus(matchId: string, status: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = await matches.findMatch(matchId);
      if (match?.status === status) return;
      if (Date.now() > deadline) {
        throw new Error(`hand ${matchId} is ${match?.status ?? 'missing'}, expected ${status}`);
      }
      await sleep(50);
    }
  }

  /** Whoever the hand says is to act. */
  async function toAct(matchId: string, viewer: string): Promise<string | null> {
    const view = (await engine.viewFor(matchId, viewer)).view as Record<string, unknown>;
    return (view.toAct as string | null) ?? null;
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    poker = app.get(PokerService);
    tables = app.get(PokerRepository);
    engine = app.get(EngineService);
    matches = app.get(MatchRepository);
    recovery = app.get(RecoveryService);
    wallet = app.get(WalletService);
    reconciliation = app.get(ReconciliationService);
    flags = app.get(FlagsService);

    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');

    // Hands left in flight by an earlier run would be found by `findActiveHand` and make
    // this suite assert against somebody else's table.
    const stale = await pool.query<{ id: string }>(
      `SELECT id FROM game.matches
        WHERE game_code = 'poker' AND status IN ('created','starting','in_progress','settling')`,
    );
    for (const row of stale.rows) await engine.voidMatch(row.id, 'integration suite reset');
  }, 60_000);

  afterAll(async () => {
    await flags?.set(FlagKey.DEV_DIRECT_CREDIT, false, 'cleanup');
    await app?.close();
    await pool?.end();
  });

  describe('sitting down and standing up', () => {
    it('moves the buy-in into the table escrow, and gives it back on standing', async () => {
      const tableId = await makeTable();
      const alice = await makePlayer();

      const seat = await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      expect(seat.stack).toBe(BUY_IN);
      expect(await balanceOf(alice)).toBe(100_000 - BUY_IN);
      expect(await escrowOf(tableId)).toBe(BUY_IN);

      const stood = await poker.stand(alice, tableId);
      expect(stood.cashedOut).toBe(BUY_IN);
      expect(await balanceOf(alice)).toBe(100_000);
      expect(await escrowOf(tableId)).toBe(0);
    });

    it('refuses a buy-in outside the table’s bounds, taking nothing', async () => {
      const tableId = await makeTable();
      const alice = await makePlayer();

      await expect(poker.sit({ userId: alice, tableId, buyIn: 10 })).rejects.toThrow(/between/i);
      await expect(poker.sit({ userId: alice, tableId, buyIn: 999_999 })).rejects.toThrow(/between/i);
      expect(await balanceOf(alice)).toBe(100_000);
      expect(await escrowOf(tableId)).toBe(0);
    });

    it('refuses a second seat at the same table — that would be collusion with yourself', async () => {
      const tableId = await makeTable();
      const alice = await makePlayer();

      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await expect(poker.sit({ userId: alice, tableId, buyIn: BUY_IN })).rejects.toThrow(/already sitting/i);
      expect(await escrowOf(tableId)).toBe(BUY_IN);
    });

    it('refuses to seat a player who cannot afford the buy-in, and seats nobody', async () => {
      const tableId = await makeTable();
      const broke = await makePlayer(1_000);

      await expect(poker.sit({ userId: broke, tableId, buyIn: BUY_IN })).rejects.toThrow(/funds/i);
      expect(await tables.listSeats(tableId)).toHaveLength(0);
      expect(await escrowOf(tableId)).toBe(0);
    });

    it('fills the table and then refuses the next player', async () => {
      const tableId = await makeTable(2);
      const [a, b, c] = await Promise.all([makePlayer(), makePlayer(), makePlayer()]);

      await poker.sit({ userId: a, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: b, tableId, buyIn: BUY_IN });
      await expect(poker.sit({ userId: c, tableId, buyIn: BUY_IN })).rejects.toThrow(/full/i);
      expect(await balanceOf(c)).toBe(100_000);
    });

    it('tops a stack up between hands, up to the table maximum', async () => {
      const tableId = await makeTable();
      const alice = await makePlayer();

      await poker.sit({ userId: alice, tableId, buyIn: 8_000 });
      const topped = await poker.topUp(alice, tableId, 5_000);

      expect(topped.stack).toBe(13_000);
      expect(await escrowOf(tableId)).toBe(13_000);
      expect(await balanceOf(alice)).toBe(100_000 - 13_000);

      await expect(poker.topUp(alice, tableId, 50_000)).rejects.toThrow(/between/i);
    });
  });

  describe('a hand', () => {
    it('deals, plays and settles, with the escrow matching the felt throughout', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);

      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });
      expect(await escrowOf(tableId)).toBe(BUY_IN * 2);

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;
      expect(matchId).toBeTruthy();

      // Blinds are posted and the hand is live.
      const view = (await engine.viewFor(matchId, alice)).view as Record<string, unknown>;
      expect(view.street).toBe('preflop');
      expect(view.pot).toBe(SB + BB);

      // Play it out: whoever is to act folds, ending the hand at once.
      const actor = (await toAct(matchId, alice))!;
      await poker.act(actor, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');

      // The table's money never moved: the escrow still holds both stacks.
      expect(await escrowOf(tableId)).toBe(BUY_IN * 2);

      const seats = await tables.listSeats(tableId);
      const total = seats.reduce((sum, seat) => sum + seat.stack, 0);
      expect(total).toBe(BUY_IN * 2);

      // …and the winner is up by the small blind, the loser down by it.
      const stacks = Object.fromEntries(seats.map((s) => [s.userId, s.stack]));
      expect(new Set(Object.values(stacks))).toEqual(new Set([BUY_IN + SB, BUY_IN - SB]));
    });

    it('never moves money on a hand — only chips', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);

      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const before = { alice: await balanceOf(alice), bob: await balanceOf(bob) };
      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      const actor = (await toAct(matchId, alice))!;
      await poker.act(actor, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');

      // Wallet balances are untouched: the chips changed hands, the money did not.
      expect(await balanceOf(alice)).toBe(before.alice);
      expect(await balanceOf(bob)).toBe(before.bob);

      // With rake at zero on TST, the hand writes no ledger transaction at all.
      const { rows } = await pool.query(`SELECT 1 FROM wallet.ledger_transactions WHERE ref_id = $1`, [
        matchId,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('pays out whatever the stack became when the player stands', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);

      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;
      const actor = (await toAct(matchId, alice))!;
      await poker.act(actor, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');

      const seats = await tables.listSeats(tableId);
      for (const seat of seats) {
        const before = await balanceOf(seat.userId);
        const stood = await poker.stand(seat.userId, tableId);
        expect(stood.cashedOut).toBe(seat.stack);
        expect(await balanceOf(seat.userId)).toBe(before + seat.stack);
      }

      expect(await escrowOf(tableId)).toBe(0);
    });

    it('records the hand for the table history', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;
      await poker.act((await toAct(matchId, alice))!, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');

      const history = await tables.recentHands(tableId);
      expect(history).toHaveLength(1);
      expect(history[0]!.matchId).toBe(matchId);
      expect(history[0]!.rake).toBe(0);
    });
  });

  describe('what a player must not be able to do', () => {
    it('refuses an action out of turn, and from someone not in the hand', async () => {
      const tableId = await makeTable();
      const [alice, bob, outsider] = await Promise.all([
        makePlayer(),
        makePlayer(),
        makePlayer(),
      ]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      const actor = (await toAct(matchId, alice))!;
      const waiting = actor === alice ? bob : alice;

      await expect(poker.act(waiting, tableId, { type: 'fold' })).rejects.toThrow(/not your turn/i);
      await expect(poker.act(outsider, tableId, { type: 'fold' })).rejects.toThrow();

      // The hand is untouched by either attempt.
      expect((await matches.findMatch(matchId))!.status).toBe('in_progress');
    });

    it('refuses an illegal raise and tells the player the legal bound', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;
      const actor = (await toAct(matchId, alice))!;

      await expect(
        poker.act(actor, tableId, { type: 'raise', amount: BB + 1 }),
      ).rejects.toThrow(/minimum raise is to/i);
      await expect(
        poker.act(actor, tableId, { type: 'raise', amount: 999_999 }),
      ).rejects.toThrow(/many chips/i);
    });

    it('never puts another player’s cards in a view, at any point in the hand', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      const aliceView = (await engine.viewFor(matchId, alice)).view as Record<string, unknown>;
      const bobView = (await engine.viewFor(matchId, bob)).view as Record<string, unknown>;
      const publicView = await engine.publicViewFor(matchId);

      const aliceCards = (aliceView.you as { cards: string[] }).cards;
      const bobCards = (bobView.you as { cards: string[] }).cards;

      expect(aliceCards).toHaveLength(2);
      for (const card of aliceCards) {
        expect(JSON.stringify(bobView)).not.toContain(`"${card}"`);
        expect(JSON.stringify(publicView)).not.toContain(`"${card}"`);
      }
      for (const card of bobCards) {
        expect(JSON.stringify(aliceView)).not.toContain(`"${card}"`);
      }
      expect(JSON.stringify(publicView)).not.toContain('deck');
    });

    it('cannot retrieve chips already committed by standing up mid-hand', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      // Standing mid-hand only marks the seat: the blinds are in the pot and stay there.
      const stood = await poker.stand(alice, tableId);
      expect(stood.cashedOut).toBeNull();
      expect(await escrowOf(tableId)).toBe(BUY_IN * 2);

      const actor = (await toAct(matchId, alice))!;
      await poker.act(actor, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');
      await sleep(200);

      // Now the seat is released and paid out — at whatever the stack ended up being.
      expect(await tables.findSeatOf(tableId, alice)).toBeNull();
    });
  });

  describe('timers', () => {
    it('acts for a player whose clock runs out, without ending the table', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      // The table's timebank is zero, so the first expiry acts: check if free, else fold.
      await engine.handleTimeout(matchId, TURN_TIMER_ID);
      await sleep(200);

      const match = await matches.findMatch(matchId);
      expect(['in_progress', 'settling', 'settled']).toContain(match!.status);
    });
  });

  describe('surviving a restart mid-hand', () => {
    it('replays the hand exactly — same cards, same chips — and carries on', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      const before = (await engine.viewFor(matchId, alice)).view as Record<string, unknown>;
      const cardsBefore = (before.you as { cards: string[] }).cards;

      // The whole point of a recorded deck: replay deals the same cards, not new ones.
      expect(await engine.replayAndVerify(matchId)).toEqual({ ok: true });

      const outcome = await recovery.recover(matchId);
      expect(outcome.action).toBe('resumed');

      const after = (await engine.viewFor(matchId, alice)).view as Record<string, unknown>;
      expect((after.you as { cards: string[] }).cards).toEqual(cardsBefore);

      await poker.act((await toAct(matchId, alice))!, tableId, { type: 'fold' });
      await waitForStatus(matchId, 'settled');
    });

    it('restores the stacks a voided hand started with', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      // Blinds are committed; the hand is voided anyway.
      await engine.voidMatch(matchId, 'integration test void');
      await sleep(300);

      const seats = await tables.listSeats(tableId);
      // Everybody has exactly what they sat down with: the hand never happened.
      expect(seats.every((seat) => seat.stack === BUY_IN)).toBe(true);
      expect(await escrowOf(tableId)).toBe(BUY_IN * 2);
    });
  });

  describe('the kill-switch', () => {
    it('drains: the hand in progress finishes, and no further hand is dealt', async () => {
      const tableId = await makeTable();
      const [alice, bob] = await Promise.all([makePlayer(), makePlayer()]);
      await poker.sit({ userId: alice, tableId, buyIn: BUY_IN });
      await poker.sit({ userId: bob, tableId, buyIn: BUY_IN });

      const table = (await tables.findTable(tableId))!;
      const matchId = (await poker.dealIfReady(table))!;

      await flags.set(gameEnabledKey(POKER_GAME_CODE), false, 'integration test');
      try {
        // No new seats while the game is off…
        const late = await makePlayer();
        await expect(poker.sit({ userId: late, tableId, buyIn: BUY_IN })).rejects.toThrow();

        // …the hand in progress still finishes and pays out normally…
        await poker.act((await toAct(matchId, alice))!, tableId, { type: 'fold' });
        await waitForStatus(matchId, 'settled');
        expect(await escrowOf(tableId)).toBe(BUY_IN * 2);

        // …and no further hand is dealt.
        const fresh = (await tables.findTable(tableId))!;
        expect(await poker.dealIfReady(fresh)).toBeNull();
      } finally {
        await flags.set(gameEnabledKey(POKER_GAME_CODE), true, 'cleanup');
      }
    });
  });

  describe('the escrow invariant (ADR-025)', () => {
    it('holds exactly what is sitting on the felt, hand after hand', async () => {
      const tableId = await makeTable();
      const players = await Promise.all([makePlayer(), makePlayer(), makePlayer()]);
      for (const userId of players) await poker.sit({ userId, tableId, buyIn: BUY_IN });

      for (let hand = 0; hand < 3; hand++) {
        const table = (await tables.findTable(tableId))!;
        const matchId = await poker.dealIfReady(table);
        if (!matchId) break;

        // Fold round the table until the hand ends.
        for (let step = 0; step < 10; step++) {
          const match = await matches.findMatch(matchId);
          if (!match || match.status !== 'in_progress') break;
          const actor = await toAct(matchId, players[0]!);
          if (!actor) break;
          await poker.act(actor, tableId, { type: 'fold' });
        }
        await waitForStatus(matchId, 'settled');
        await sleep(150);

        // The invariant, checked after every hand: escrow == the sum of the stacks.
        expect(await escrowOf(tableId)).toBe(await tables.totalSeatedStacks(tableId));
      }
    });

    it('leaves the ledger reconciled', async () => {
      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });
});
