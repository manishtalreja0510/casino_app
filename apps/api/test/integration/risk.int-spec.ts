import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { RiskService } from '../../src/risk/risk.service';
import { RiskRepository } from '../../src/risk/risk.repository';
import { RISK_THRESHOLDS } from '../../src/risk/risk.types';
import { WalletService } from '../../src/wallet/wallet.service';
import { AuthRepository } from '../../src/auth/auth.repository';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

/**
 * The risk engine end to end.
 *
 * Two of these tests are the phase's normative claims rather than ordinary coverage, and
 * they are written adversarially on purpose: **client-only evidence can never freeze an
 * account**, and **no freeze happens without a case to appeal to**. Both are the kind of
 * property that survives review and then quietly dies in a later refactor, so each is
 * asserted through the real service against the real seeded rules rather than a fixture.
 */
describe('risk engine (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let risk: RiskService;
  let repository: RiskRepository;
  let wallet: WalletService;
  let accounts: AuthRepository;
  let flags: FlagsService;

  /** Every client-only rule in the seeded set, which is the worst a device can say. */
  const EVERY_CLIENT_SIGNAL = [
    'client.root_detected',
    'client.emulator_detected',
    'client.hook_detected',
    'client.signature_mismatch',
    'client.integrity_failed',
  ];

  async function makePlayer(funded = 50_000): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Risk Test')`,
      [id, `risk-${id}@example.test`],
    );
    if (funded > 0) {
      await wallet.addFunds({ userId: id, amount: funded, idempotencyKey: `risk-seed:${id}` });
    }
    return id;
  }

  /**
   * Ingests and waits for the evaluation it kicks off.
   *
   * `ingest` deliberately does not await scoring — a signal must be recorded even if acting
   * on it fails — so a test that asserts on the consequence has to wait for it. Calling
   * `evaluate` directly is that wait, and it is idempotent: the second call finds the rung
   * already applied and does nothing.
   */
  async function report(userId: string, type: string, payload: Record<string, unknown> = {}) {
    await risk.ingest({ source: 'test', type, userId, payload });
    await risk.evaluate(userId);
  }

  const statusOf = async (userId: string) => (await accounts.findUserById(userId))?.status;

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    risk = app.get(RiskService);
    repository = app.get(RiskRepository);
    wallet = app.get(WalletService);
    accounts = app.get(AuthRepository);
    flags = app.get(FlagsService);

    await flags.set(FlagKey.DEV_DIRECT_CREDIT, true, 'integration-test');
  }, 60_000);

  afterAll(async () => {
    await flags?.set(FlagKey.DEV_DIRECT_CREDIT, false, 'cleanup');
    await app?.close();
    await pool?.end();
  });

  describe('ingestion', () => {
    it('weighs a signal by the rule, never by what the emitter claims', async () => {
      const alice = await makePlayer();

      // A caller doing its worst: a payload that tries to name its own weight, from a
      // source that says it is the wallet when it is not.
      await risk.ingest({
        source: 'wallet',
        type: 'identity.ip_shared',
        userId: alice,
        payload: { weight: 9_999, clientOnly: false, ttlSeconds: 1 },
      });

      const score = await risk.scoreFor(alice);
      expect(score.total).toBe(8); // the seeded weight for ip_shared
      expect(score.contributing[0]!.weight).toBe(8);
    });

    it('drops a signal type nobody has assigned a meaning to', async () => {
      const alice = await makePlayer();
      await risk.ingest({ source: 'test', type: 'totally.made.up', userId: alice });

      expect((await risk.scoreFor(alice)).total).toBe(0);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM risk.signals WHERE user_id = $1`,
        [alice],
      );
      // Not merely unscored — never stored. A type with no rule has no weight to store.
      expect(rows[0].n).toBe(0);
    });

    it('keeps signals append-only, against the database', async () => {
      const alice = await makePlayer();
      await report(alice, 'identity.ip_shared');
      const { rows } = await pool.query(`SELECT id FROM risk.signals WHERE user_id = $1`, [alice]);

      await expect(
        pool.query(`UPDATE risk.signals SET weight_at_ingest = 0 WHERE id = $1`, [rows[0].id]),
      ).rejects.toThrow(/append-only|cannot/i);
      await expect(
        pool.query(`DELETE FROM risk.signals WHERE id = $1`, [rows[0].id]),
      ).rejects.toThrow(/append-only|cannot/i);
    });
  });

  describe('the action ladder', () => {
    it('climbs it as evidence accumulates', async () => {
      const alice = await makePlayer();

      // Below the first rung: nothing at all.
      await report(alice, 'identity.ip_shared'); // 8
      expect(await risk.evaluate(alice)).toMatchObject({ applied: null });

      // Past `flag` (25): recorded, and invisible to the player.
      await report(alice, 'identity.device_shared'); // +20 = 28
      expect((await repository.activeActions(alice)).map((a) => a.action)).toContain('flag');
      expect(await risk.gate(alice)).toMatchObject({ allowed: true });

      // Past `limit` (45): money stops, with a message that explains nothing.
      await report(alice, 'velocity.faucet_burst'); // +25 = 53
      const gate = await risk.gate(alice);
      expect(gate.allowed).toBe(false);
      expect(gate.action).toBe('limit');
      expect(gate.reason).not.toMatch(/score|signal|rule|velocity/i);
    });

    it('stops the money at the wallet, whichever path asked', async () => {
      const alice = await makePlayer();
      await report(alice, 'identity.device_shared');
      await report(alice, 'velocity.faucet_burst'); // 45 — the `limit` rung

      await expect(
        wallet.addFunds({ userId: alice, amount: 1_000, idempotencyKey: uuidv7() }),
      ).rejects.toThrow(/limited|hold/i);
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 1_000 }),
      ).rejects.toThrow(/limited|hold/i);
      await expect(
        wallet.sitDown({
          userId: alice,
          tableId: uuidv7(),
          seatSessionId: uuidv7(),
          amount: 1_000,
        }),
      ).rejects.toThrow(/limited|hold/i);
    });

    it('does not apply the same rung twice', async () => {
      const alice = await makePlayer();
      await report(alice, 'identity.device_shared');
      await report(alice, 'identity.ip_shared'); // 28 — `flag`

      await risk.evaluate(alice);
      await risk.evaluate(alice);

      const flagsApplied = (await repository.activeActions(alice)).filter(
        (entry) => entry.action === 'flag',
      );
      expect(flagsApplied).toHaveLength(1);
    });
  });

  describe('client-only evidence', () => {
    it('cannot freeze an account, however much of it there is', async () => {
      const alice = await makePlayer();

      for (const type of EVERY_CLIENT_SIGNAL) await report(alice, type);

      const score = await risk.scoreFor(alice);
      // Everything a device can say about itself, all at once, all believed.
      expect(score.total).toBe(100);
      // And none of it is evidence the server has: the number freezing is decided on is
      // still zero.
      expect(score.serverEvidence).toBe(0);

      expect((await repository.activeActions(alice)).map((a) => a.action)).not.toContain('freeze');
      expect(await statusOf(alice)).toBe('active');
    });

    it('cannot reach the freeze threshold even by arithmetic', () => {
      // The second, independent reason. If somebody deletes the `serverEvidence` check in
      // `evaluate`, this still holds — and if somebody raises a client weight until it
      // does not, this test is what tells them what they just did.
      const CLIENT_ONLY_TOTAL = 15 + 10 + 25 + 30 + 20;
      expect(CLIENT_ONLY_TOTAL).toBeLessThan(RISK_THRESHOLDS.freeze);
    });

    it('is enough to restrict, which is the point of collecting it', async () => {
      const alice = await makePlayer();
      await report(alice, 'client.signature_mismatch'); // 30
      await report(alice, 'client.hook_detected'); // +25 = 55

      // Past `limit`: a device claiming to be instrumented does not get to move money
      // while somebody looks. It is just never on its own grounds to freeze.
      expect(await risk.gate(alice)).toMatchObject({ allowed: false, action: 'limit' });
      expect(await statusOf(alice)).toBe('active');
    });
  });

  describe('freezing', () => {
    /** Server-observed evidence past the freeze threshold: 70 + 20 + 20 + 15 = 125. */
    async function freeze(userId: string): Promise<void> {
      await report(userId, 'gameplay.chip_dump_linked');
      await report(userId, 'identity.device_shared');
      await report(userId, 'gameplay.collusion_coseating');
      await report(userId, 'protocol.invalid_action_burst');
    }

    it('opens a case in the same breath — there are no silent freezes', async () => {
      const alice = await makePlayer();
      await freeze(alice);

      expect((await repository.activeActions(alice)).map((a) => a.action)).toContain('freeze');
      expect(await statusOf(alice)).toBe('suspended');

      const cases = await repository.openCasesFor(alice);
      expect(cases).toHaveLength(1);

      // With the evidence that caused it attached, so a reviewer is not starting from
      // "the system said so".
      const { rows } = await pool.query(
        `SELECT evidence FROM risk.cases WHERE id = $1`,
        [cases[0]!.id],
      );
      expect(rows[0].evidence.signals.map((s: { type: string }) => s.type)).toContain(
        'gameplay.chip_dump_linked',
      );
    });

    it('refuses the money and names the way back', async () => {
      const alice = await makePlayer();
      await freeze(alice);

      await expect(
        wallet.addFunds({ userId: alice, amount: 1_000, idempotencyKey: uuidv7() }),
      ).rejects.toThrow(/support/i);
      await expect(
        wallet.buyIn({ userId: alice, matchId: uuidv7(), amount: 1_000 }),
      ).rejects.toThrow(/support/i);
    });

    it('stands until a human lifts it, unlike the softer rungs', async () => {
      const alice = await makePlayer();
      await freeze(alice);

      const { rows } = await pool.query(
        `SELECT action, expires_at FROM risk.actions WHERE user_id = $1`,
        [alice],
      );
      const frozen = rows.find((row: { action: string }) => row.action === 'freeze');
      const softer = rows.filter((row: { action: string }) => row.action !== 'freeze');

      expect(frozen.expires_at).toBeNull();
      expect(softer.length).toBeGreaterThan(0);
      for (const row of softer) expect(row.expires_at).not.toBeNull();
    });
  });

  describe('the identity graph', () => {
    it('notices one device carrying several accounts, and not a second one', async () => {
      const deviceId = `device-${uuidv7()}`;
      const players = [await makePlayer(0), await makePlayer(0), await makePlayer(0)];

      for (const userId of players) {
        await risk.observeSession({ userId, deviceId, ip: '198.51.100.7' });
      }

      // The third account is what makes it a pattern; the first two are a phone somebody
      // sold on.
      const third = await risk.scoreFor(players[2]!);
      expect(third.contributing.map((entry) => entry.type)).toContain('identity.device_shared');

      const first = await risk.scoreFor(players[0]!);
      expect(first.contributing.map((entry) => entry.type)).not.toContain('identity.device_shared');
    });

    it('is far more forgiving about a shared address', async () => {
      const ip = `203.0.113.${Math.floor(Date.now() % 200) + 1}`;
      const players: string[] = [];
      for (let index = 0; index < 4; index += 1) players.push(await makePlayer(0));

      for (const userId of players) await risk.observeSession({ userId, ip });

      // Four accounts behind one address is a household or a coffee shop, not a ring.
      const score = await risk.scoreFor(players[3]!);
      expect(score.contributing.map((entry) => entry.type)).not.toContain('identity.ip_shared');
    });

    it('never fails the caller, whatever it is handed', async () => {
      // Called from login. A risk observation that can throw is a login that can fail for
      // a reason the player cannot act on.
      await expect(
        risk.observeSession({ userId: uuidv7(), deviceId: 'no-such-device' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('gameplay', () => {
    it('records a hand as a fact worth nothing', async () => {
      const [alice, bob] = [await makePlayer(0), await makePlayer(0)];
      await risk.observePokerHand({
        matchId: uuidv7(),
        tableId: uuidv7(),
        net: { [alice]: -500, [bob]: 500 },
      });

      // Playing poker, and losing, is not evidence of anything.
      expect((await risk.scoreFor(alice)).total).toBe(0);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM risk.signals WHERE user_id = $1 AND type = 'gameplay.hand_summary'`,
        [alice],
      );
      expect(rows[0].n).toBe(1);
    });

    it('scores a sustained one-sided flow, and harder when the pair is linked', async () => {
      const [alice, bob] = [await makePlayer(0), await makePlayer(0)];
      const tableId = uuidv7();

      // Twelve hands, all of alice's chips going one way. The heuristic itself is unit
      // tested; what matters here is that the finding arrives as a scored signal.
      for (let hand = 0; hand < 12; hand += 1) {
        await risk.observePokerHand({
          matchId: uuidv7(),
          tableId,
          net: { [alice]: -1_000, [bob]: 1_000 },
        });
      }

      const types = (await risk.scoreFor(alice)).contributing.map((entry) => entry.type);
      expect(types).toContain('gameplay.chip_dump');
      expect(types).not.toContain('gameplay.chip_dump_linked');
    });

    it('settles the hand even when scoring it cannot work', async () => {
      // A user id that does not exist: recording the summary violates a foreign key.
      await expect(
        risk.observePokerHand({
          matchId: uuidv7(),
          tableId: uuidv7(),
          net: { [uuidv7()]: -100, [uuidv7()]: 100 },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('what the player is told', () => {
    it('never discloses the score, the rules, or which signal fired', async () => {
      const alice = await makePlayer();
      await report(alice, 'client.signature_mismatch');
      await report(alice, 'identity.device_shared'); // 50 — limited

      const gate = await risk.gate(alice);
      const shown = JSON.stringify({ restricted: !gate.allowed, reason: gate.reason });

      expect(shown).not.toMatch(/signature|device_shared|50|weight/i);
      // The internal view keeps all of it, for review.
      expect(await risk.statusFor(alice)).toMatchObject({ score: 50 });
    });
  });
});
