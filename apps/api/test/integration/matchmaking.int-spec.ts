import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { MatchmakingService, AlreadyInMatchError, InsufficientBalanceForTierError } from '../../src/matchmaking/matchmaking.service';
import { MatchmakingRepository } from '../../src/matchmaking/matchmaking.repository';
import { QueueService } from '../../src/matchmaking/queue.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { ReconciliationService } from '../../src/wallet/reconciliation.service';
import { MatchRepository } from '../../src/game-engine/match.repository';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

const MICRO_TIER = 'coin-duel:micro'; // stake 1000
const FREE_TIER = 'coin-duel:free'; // stake 0

describe('matchmaking (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let matchmaking: MatchmakingService;
  let repository: MatchmakingRepository;
  let queues: QueueService;
  let wallet: WalletService;
  let matches: MatchRepository;
  let reconciliation: ReconciliationService;
  let flags: FlagsService;

  async function makePlayer(funded = 10_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'MM Test')`,
      [id, `mm-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `mm-seed:${id}` });
    }
    return id;
  }

  /** Each test uses its own tier so leftovers cannot bleed between them. */
  async function makeTier(stake: number): Promise<string> {
    // The TAIL of a v7 uuid, not the head: the first bytes are the millisecond timestamp,
    // so two tiers created in the same tick would collide on a prefix slice.
    const id = `coin-duel:test-${uuidv7().slice(-12)}`;
    await pool.query(
      `INSERT INTO game.stake_tiers (id, game_code, name, stake) VALUES ($1, 'coin-duel', 'Test', $2)`,
      [id, stake],
    );
    return id;
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    matchmaking = app.get(MatchmakingService);
    repository = app.get(MatchmakingRepository);
    queues = app.get(QueueService);
    wallet = app.get(WalletService);
    matches = app.get(MatchRepository);
    reconciliation = app.get(ReconciliationService);
    flags = app.get(FlagsService);

    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
    await flags.set('game.coin-duel.enabled', true, 'integration-test');
  }, 60_000);

  afterAll(async () => {
    await flags.set(FlagKey.DEV_DIRECT_CREDIT, false, 'cleanup');
    await app.close();
    await pool.end();
  });

  describe('queue and formation', () => {
    it('forms a match when the second player joins, charging both exactly once', async () => {
      const tier = await makeTier(1000);
      const [a, b] = await Promise.all([makePlayer(), makePlayer()]);

      const first = await matchmaking.joinQueue(a, tier);
      expect(first.queued).toBe(true);
      expect(first.matchId).toBeUndefined();

      const second = await matchmaking.joinQueue(b, tier);
      expect(second.matchId).toEqual(expect.any(String));

      const [balanceA, balanceB] = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      expect(balanceA.amount).toBe(9_000);
      expect(balanceB.amount).toBe(9_000);

      const match = await matches.findMatch(second.matchId!);
      expect(match?.status).toBe('in_progress');
      expect((await matches.listPlayers(second.matchId!)).map((p) => p.userId).sort()).toEqual(
        [a, b].sort(),
      );
    });

    it('leaves the queue empty after forming', async () => {
      const tier = await makeTier(0);
      const [a, b] = await Promise.all([makePlayer(), makePlayer()]);
      await matchmaking.joinQueue(a, tier);
      await matchmaking.joinQueue(b, tier);

      expect(await queues.depth(tier)).toBe(0);
      expect(await queues.isQueued(tier, a)).toBe(false);
    });

    it('lets a player leave the queue', async () => {
      const tier = await makeTier(0);
      const a = await makePlayer();
      await matchmaking.joinQueue(a, tier);
      expect((await matchmaking.queueStatus(a, tier)).queued).toBe(true);

      expect((await matchmaking.leaveQueue(a, tier)).left).toBe(true);
      expect((await matchmaking.queueStatus(a, tier)).queued).toBe(false);
    });

    it('refuses to queue the same player twice', async () => {
      const tier = await makeTier(0);
      const a = await makePlayer();
      await matchmaking.joinQueue(a, tier);

      // A second device must not create a second place in line — that is how a player
      // ends up matched against themselves.
      const again = await matchmaking.joinQueue(a, tier);
      expect(again.queued).toBe(true);
      expect(await queues.depth(tier)).toBe(1);
    });

    it('never seats a player against themselves', async () => {
      const tier = await makeTier(0);
      const a = await makePlayer();
      await matchmaking.joinQueue(a, tier);
      await matchmaking.joinQueue(a, tier);
      await matchmaking.joinQueue(a, tier);

      const tierRow = await repository.findTier(tier);
      expect(await matchmaking.tryForm(tierRow!)).toBeNull();
    });

    it('refuses a player already in a match', async () => {
      const tier = await makeTier(0);
      const [a, b] = await Promise.all([makePlayer(), makePlayer()]);
      await matchmaking.joinQueue(a, tier);
      await matchmaking.joinQueue(b, tier);

      await expect(matchmaking.joinQueue(a, tier)).rejects.toBeInstanceOf(AlreadyInMatchError);
    });

    it('refuses to queue without enough funds for the tier', async () => {
      const tier = await makeTier(5000);
      const poor = await makePlayer(1000);
      await expect(matchmaking.joinQueue(poor, tier)).rejects.toBeInstanceOf(
        InsufficientBalanceForTierError,
      );
    });

    it('refuses queueing for a disabled game (rule 16)', async () => {
      const tier = await makeTier(0);
      const a = await makePlayer();
      await flags.set('game.coin-duel.enabled', false, 'test');
      try {
        await expect(matchmaking.joinQueue(a, tier)).rejects.toThrow(/not available/i);
      } finally {
        await flags.set('game.coin-duel.enabled', true, 'test');
      }
    });
  });

  describe('all-or-nothing formation', () => {
    it('charges NOBODY when one player cannot pay at formation time', async () => {
      const tier = await makeTier(5000);
      const rich = await makePlayer(10_000);
      const borderline = await makePlayer(5000);

      // Queued directly rather than through joinQueue, because joining is what triggers
      // formation — this test needs both players waiting so the race can be staged.
      await queues.join({ userId: rich, tierId: tier, gameCode: 'coin-duel', joinedAt: Date.now() });
      await queues.join({
        userId: borderline,
        tierId: tier,
        gameCode: 'coin-duel',
        joinedAt: Date.now(),
      });

      // The second player's funds vanish between queueing and formation — the exact race
      // that a sequential buy-in would resolve by charging the first player for a match
      // that never starts.
      await wallet.buyIn({ userId: borderline, matchId: uuidv7(), amount: 5000 });
      expect((await wallet.getBalance(borderline)).amount).toBe(0);

      const tierRow = await repository.findTier(tier);
      const formed = await matchmaking.tryForm(tierRow!);
      expect(formed).toBeNull();

      // The wealthy player is untouched: no stake taken for a match that never existed.
      expect((await wallet.getBalance(rich)).amount).toBe(10_000);

      const { rows } = await pool.query(
        `SELECT outcome, reason FROM game.formations WHERE tier_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tier],
      );
      expect(rows[0].outcome).toBe('failed');
    });

    it('leaves the ledger reconciled after a failed formation', async () => {
      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('forms exactly one match from four simultaneous joins, seating each player once', async () => {
      const tier = await makeTier(1000);
      const players = await Promise.all([makePlayer(), makePlayer(), makePlayer(), makePlayer()]);

      // Four players racing: with a two-player game that must produce exactly two matches
      // and no player in more than one.
      const results = await Promise.all(
        players.map((userId) => matchmaking.joinQueue(userId, tier).catch((error) => error)),
      );

      const errors = results.filter((r) => r instanceof Error);
      expect(errors).toEqual([]);

      // Read what actually happened from the database, NOT from who the calls told.
      //
      // `joinQueue` returns a match id only when the caller's own formation attempt seated
      // the caller. Under a real race that is genuinely unpredictable: one player's attempt
      // can claim two *other* queued players and form a match it is not in, so a match
      // exists that no caller was told about. An earlier version of this test counted the
      // returned ids and failed roughly one run in three — not because anything was wrong,
      // but because it was asserting which caller happened to be informed rather than
      // whether the seating and the money were right.
      const { rows } = await pool.query<{ match_id: string; user_id: string }>(
        `SELECT mp.match_id, mp.user_id
           FROM game.match_players mp
           JOIN game.matches m ON m.id = mp.match_id
          WHERE mp.user_id = ANY($1::uuid[])`,
        [players],
      );

      const matchIds = new Set(rows.map((row) => row.match_id));
      expect(matchIds.size).toBe(2);

      const seatedBy = new Map<string, number>();
      for (const matchId of matchIds) {
        for (const player of await matches.listPlayers(matchId)) {
          seatedBy.set(player.userId, (seatedBy.get(player.userId) ?? 0) + 1);
        }
      }
      // The property that matters: nobody is seated twice, and everyone paid once.
      expect([...seatedBy.values()].every((count) => count === 1)).toBe(true);
      expect(seatedBy.size).toBe(4);

      for (const userId of players) {
        expect((await wallet.getBalance(userId)).amount).toBe(9_000);
      }
    });

    it('claims each queued player at most once under concurrent formation attempts', async () => {
      const tier = await makeTier(0);
      const players = await Promise.all([makePlayer(0), makePlayer(0), makePlayer(0), makePlayer(0)]);
      for (const userId of players) await queues.join({ userId, tierId: tier, gameCode: 'coin-duel', joinedAt: Date.now() });

      // Eight concurrent claims for pairs: the Lua script must hand each player to exactly
      // one caller, so at most two claims succeed and no id appears twice.
      const claims = await Promise.all(Array.from({ length: 8 }, () => queues.claim(tier, 2)));
      const claimed = claims.flat();

      expect(claimed.length).toBeLessThanOrEqual(4);
      expect(new Set(claimed).size).toBe(claimed.length);
    });
  });

  describe('lobby', () => {
    it('lists games with tiers, queue depth and active match counts', async () => {
      const tier = await makeTier(0);
      const a = await makePlayer();
      await matchmaking.joinQueue(a, tier);

      const lobby = await matchmaking.lobby();
      const game = lobby.games.find((entry) => entry.gameCode === 'coin-duel');

      expect(game).toBeDefined();
      expect(game!.name).toBe('Coin Duel (reference)');
      expect(game!.enabled).toBe(true);
      expect(game!.tiers.find((t) => t.id === tier)?.queueDepth).toBe(1);
      expect(game!.tiers.some((t) => t.id === MICRO_TIER)).toBe(true);

      await matchmaking.leaveQueue(a, tier);
    });

    it('reports a game as disabled without removing it from the lobby', async () => {
      await flags.set('game.coin-duel.enabled', false, 'test');
      try {
        const lobby = await matchmaking.lobby();
        const game = lobby.games.find((entry) => entry.gameCode === 'coin-duel');
        // Shown but not joinable: a player should see the game exists and is down, rather
        // than it vanishing with no explanation.
        expect(game?.enabled).toBe(false);
      } finally {
        await flags.set('game.coin-duel.enabled', true, 'test');
      }
    });

    it('exposes the seeded tiers for the reference game', async () => {
      const tiers = await repository.listTiers('coin-duel');
      expect(tiers.map((tier) => tier.id)).toEqual(
        expect.arrayContaining([FREE_TIER, MICRO_TIER, 'coin-duel:low']),
      );
    });
  });

  describe('queue hygiene', () => {
    it('drops entries that have gone stale rather than blocking the tier', async () => {
      const tier = await makeTier(0);
      const stale = await makePlayer(0);
      const fresh = await makePlayer(0);

      // A player who queued and vanished long ago must not hold up the people behind them.
      await queues.join({
        userId: stale,
        tierId: tier,
        gameCode: 'coin-duel',
        joinedAt: Date.now() - (QueueService.entryTtlSeconds + 60) * 1000,
      });
      await queues.join({ userId: fresh, tierId: tier, gameCode: 'coin-duel', joinedAt: Date.now() });

      const claimed = await queues.claim(tier, 1);
      expect(claimed).toEqual([fresh]);
    });
  });
});
