import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { EngineService } from '../../src/game-engine/engine.service';
import { RecoveryService } from '../../src/game-engine/recovery.service';
import { MatchRepository } from '../../src/game-engine/match.repository';
import { WalletService } from '../../src/wallet/wallet.service';
import { ReconciliationService } from '../../src/wallet/reconciliation.service';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { NotAParticipantError, InvalidActionError } from '../../src/game-engine/engine.errors';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

/**
 * The engine's guarantees end to end: real money into escrow, real events in PostgreSQL,
 * real recovery from a simulated crash, and information hiding enforced by the contract.
 */
describe('game engine (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let engine: EngineService;
  let recovery: RecoveryService;
  let matches: MatchRepository;
  let wallet: WalletService;
  let reconciliation: ReconciliationService;

  const STAKE = 1000;

  async function makePlayer(funded = 10_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Engine Test')`,
      [id, `engine-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `engine-seed:${id}` });
    }
    return id;
  }

  async function startMatch(): Promise<{ matchId: string; a: string; b: string }> {
    const [a, b] = await Promise.all([makePlayer(), makePlayer()]);
    const { matchId } = await engine.createMatch({
      gameCode: 'coin-duel',
      players: [{ userId: a }, { userId: b }],
      stake: STAKE,
    });
    return { matchId, a, b };
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    engine = app.get(EngineService);
    recovery = app.get(RecoveryService);
    matches = app.get(MatchRepository);
    wallet = app.get(WalletService);
    reconciliation = app.get(ReconciliationService);

    await app.get(FlagsService).set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
  }, 60_000);

  afterAll(async () => {
    await app.get(FlagsService).set(FlagKey.DEV_DIRECT_CREDIT, false, 'cleanup');
    await app.close();
    await pool.end();
  });

  describe('match lifecycle', () => {
    it('takes buy-ins into escrow when a match starts', async () => {
      const { matchId, a, b } = await startMatch();

      // A match must not exist unless the money backing it does.
      expect((await wallet.getBalance(a)).amount).toBe(10_000 - STAKE);
      expect((await wallet.getBalance(b)).amount).toBe(10_000 - STAKE);

      const match = await matches.findMatch(matchId);
      expect(match?.status).toBe('in_progress');
    });

    it('plays to completion and settles the pot exactly', async () => {
      const { matchId, a, b } = await startMatch();

      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      const match = await matches.findMatch(matchId);
      expect(match?.status).toBe('settled');

      // Exactly one of them called it right, so the pot is 2 × STAKE and nothing is lost.
      const [balanceA, balanceB] = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      expect(balanceA.amount + balanceB.amount).toBe(20_000);
      // Numeric sort: JavaScript's default is lexicographic, which would compare
      // "11000" < "9000" and pass for the wrong reason.
      expect([balanceA.amount, balanceB.amount].sort((x, y) => x - y)).toEqual([9_000, 11_000]);

      // And the escrow is empty, which is the invariant reconciliation watches.
      const { rows } = await pool.query(
        `SELECT b.amount FROM wallet.balances b JOIN wallet.accounts a ON a.id = b.account_id
          WHERE a.match_id = $1`,
        [matchId],
      );
      expect(Number(rows[0].amount)).toBe(0);
    });

    it('returns stakes when nobody wins', async () => {
      const { matchId, a, b } = await startMatch();
      // Both pick the same side: exactly one of the two outcomes leaves no winner.
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'heads' } });

      const [balanceA, balanceB] = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      // Either both won (10,000 each after splitting the pot) or both were refunded.
      expect(balanceA.amount + balanceB.amount).toBe(20_000);
    });

    it('records an append-only event log', async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      const events = await matches.listEvents(matchId);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0]!.type).toBe('match:init');
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

      // The match history is evidence, not a cache.
      await expect(
        pool.query('UPDATE game.game_events SET type = $1 WHERE match_id = $2', ['tampered', matchId]),
      ).rejects.toThrow(/append-only/i);
    });

    it('records every RNG draw against the match that consumed it', async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      const { rows } = await pool.query(
        `SELECT payload->'__draws' AS draws FROM game.game_events
          WHERE match_id = $1 AND payload ? '__draws'`,
        [matchId],
      );
      const draws = rows.flatMap((row) => row.draws as Array<{ purpose: string }>);
      // The coin flip must be attributable — a disputed outcome has to be checkable.
      expect(draws.some((draw) => draw.purpose === 'coin-flip')).toBe(true);
    });
  });

  describe('authorisation and validation', () => {
    it('REFUSES an action from someone not in the match', async () => {
      const { matchId } = await startMatch();
      const outsider = await makePlayer(0);

      await expect(
        engine.submitAction(matchId, { type: 'pick', userId: outsider, payload: { choice: 'heads' } }),
      ).rejects.toBeInstanceOf(NotAParticipantError);
    });

    it('refuses an out-of-turn action', async () => {
      const { matchId, b } = await startMatch();
      // Seat 0 acts first; seat 1 trying to act now is out of turn.
      await expect(
        engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'heads' } }),
      ).rejects.toBeInstanceOf(InvalidActionError);
    });

    it('refuses a malformed action without mutating state', async () => {
      const { matchId, a } = await startMatch();
      const before = await matches.listEvents(matchId);

      await expect(
        engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'edge' } }),
      ).rejects.toBeInstanceOf(InvalidActionError);

      // A rejected action leaves no trace — it never happened.
      expect((await matches.listEvents(matchId)).length).toBe(before.length);
    });

    it('refuses actions once the match has ended', async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      await expect(
        engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } }),
      ).rejects.toThrow();
    });
  });

  describe('information hiding', () => {
    it("never puts a player's pick in the opponent's view before the reveal", async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });

      const opponentView = await engine.viewFor(matchId, b);
      const serialised = JSON.stringify(opponentView);

      // B may know that A has acted, never what A chose. This is the same guarantee that
      // keeps hole cards private in poker (P9).
      expect((opponentView.view as Record<string, unknown>).picks).toBeNull();
      expect((opponentView.view as Record<string, unknown>).yourPick).toBeNull();
      expect(serialised).toContain('picked');

      const ownView = await engine.viewFor(matchId, a);
      expect((ownView.view as Record<string, unknown>).yourPick).toBe('heads');
    });

    it('refuses to build a view for a non-participant', async () => {
      const { matchId } = await startMatch();
      const outsider = await makePlayer(0);
      await expect(engine.viewFor(matchId, outsider)).rejects.toBeInstanceOf(NotAParticipantError);
    });
  });

  describe('crash recovery', () => {
    it('verifies a healthy match replays cleanly and resumes it', async () => {
      const { matchId, a } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });

      expect(await engine.replayAndVerify(matchId)).toEqual({ ok: true });

      const outcome = await recovery.recover(matchId);
      expect(outcome.action).toBe('resumed');
      expect((await matches.findMatch(matchId))?.status).toBe('in_progress');
    });

    it('VOIDS and REFUNDS a match whose event log cannot be replayed', async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });

      const balancesBefore = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      expect(balancesBefore[0].amount).toBe(9_000);

      // Tamper with the recorded state so replay no longer matches what was stored.
      // Events are append-only for the app role, so this is done as the table owner —
      // simulating the corruption recovery must survive rather than trust.
      await pool.query('ALTER TABLE game.game_events DISABLE TRIGGER game_events_no_mutation');
      await pool.query(
        `UPDATE game.game_events
            SET payload = jsonb_set(payload, '{state,pot}', '999999')
          WHERE match_id = $1 AND seq = 2`,
        [matchId],
      );
      await pool.query('ALTER TABLE game.game_events ENABLE TRIGGER game_events_no_mutation');

      const verification = await engine.replayAndVerify(matchId);
      expect(verification.ok).toBe(false);

      const outcome = await recovery.recover(matchId);
      expect(outcome.action).toBe('voided');

      // The only defensible outcome: every stake back, nothing invented.
      const [afterA, afterB] = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      expect(afterA.amount).toBe(10_000);
      expect(afterB.amount).toBe(10_000);

      const match = await matches.findMatch(matchId);
      expect(match?.status).toBe('voided');
      expect(match?.voidReason).toMatch(/unrecoverable/);

      const { rows } = await pool.query(
        "SELECT 1 FROM audit.audit_log WHERE action = 'game.voided' AND subject_ref = $1",
        [matchId],
      );
      expect(rows).toHaveLength(1);
    });

    it('completes settlement for a match that crashed after deciding the outcome', async () => {
      const { matchId, a, b } = await startMatch();
      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      // Simulate a crash between deciding and paying: rewind the status to `settling`.
      await pool.query("UPDATE game.matches SET status = 'settling' WHERE id = $1", [matchId]);

      const outcome = await recovery.recover(matchId);
      expect(outcome.action).toBe('settled');

      // Settlement is idempotent, so completing it a second time pays once, not twice.
      const [balanceA, balanceB] = await Promise.all([wallet.getBalance(a), wallet.getBalance(b)]);
      expect(balanceA.amount + balanceB.amount).toBe(20_000);
    });
  });

  describe('free play (zero stake)', () => {
    it('settles a free match, which moves no money at all', async () => {
      // Found by startup recovery, not by a unit test: a zero-stake settlement would have
      // posted a single zero entry, which the ledger refuses — so free-play matches could
      // never finish. The lobby offers a free tier, so this is a real path.
      const [a, b] = await Promise.all([makePlayer(0), makePlayer(0)]);
      const { matchId } = await engine.createMatch({
        gameCode: 'coin-duel',
        players: [{ userId: a }, { userId: b }],
        stake: 0,
      });

      await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
      await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });

      expect((await matches.findMatch(matchId))?.status).toBe('settled');
      expect((await wallet.getBalance(a)).amount).toBe(0);
      expect((await wallet.getBalance(b)).amount).toBe(0);
      expect((await reconciliation.run()).ok).toBe(true);
    });

    it('voids a free match without attempting a refund', async () => {
      const [a, b] = await Promise.all([makePlayer(0), makePlayer(0)]);
      const { matchId } = await engine.createMatch({
        gameCode: 'coin-duel',
        players: [{ userId: a }, { userId: b }],
        stake: 0,
      });

      await engine.voidMatch(matchId, 'test void');
      expect((await matches.findMatch(matchId))?.status).toBe('voided');
      expect((await reconciliation.run()).ok).toBe(true);
    });
  });

  describe('per-game kill-switch (rule 16)', () => {
    it('REFUSES to create a match for a disabled game, before any money moves', async () => {
      const flags = app.get(FlagsService);
      const [a, b] = await Promise.all([makePlayer(), makePlayer()]);

      await flags.set('game.coin-duel.enabled', false, 'integration-test');
      try {
        await expect(
          engine.createMatch({
            gameCode: 'coin-duel',
            players: [{ userId: a }, { userId: b }],
            stake: STAKE,
          }),
        ).rejects.toThrow(/unavailable/i);

        // Nothing was taken: the switch is checked before buy-ins, so pulling it cannot
        // strand a player's stake.
        expect((await wallet.getBalance(a)).amount).toBe(10_000);
        expect((await wallet.getBalance(b)).amount).toBe(10_000);
      } finally {
        await flags.set('game.coin-duel.enabled', true, 'integration-test');
      }
    });

    it('leaves matches already in flight playable when the switch is pulled', async () => {
      const flags = app.get(FlagsService);
      const { matchId, a, b } = await startMatch();

      await flags.set('game.coin-duel.enabled', false, 'integration-test');
      try {
        // Draining rather than cutting: players mid-match finish, only new matches stop.
        await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
        await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });
        expect((await matches.findMatch(matchId))?.status).toBe('settled');
      } finally {
        await flags.set('game.coin-duel.enabled', true, 'integration-test');
      }
    });
  });

  describe('ledger integrity after gameplay', () => {
    it('leaves the ledger reconciled after a batch of matches', async () => {
      for (let i = 0; i < 3; i++) {
        const { matchId, a, b } = await startMatch();
        await engine.submitAction(matchId, { type: 'pick', userId: a, payload: { choice: 'heads' } });
        await engine.submitAction(matchId, { type: 'pick', userId: b, payload: { choice: 'tails' } });
      }

      const report = await reconciliation.run();
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });
});
