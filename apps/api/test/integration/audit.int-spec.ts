import type { Pool } from 'pg';
import { AuditService } from '../../src/platform/audit/audit.service';
import { AuditChainService } from '../../src/platform/audit/audit-chain.service';
import { ensureMigrated, testPool } from './db';

/**
 * The audit log is the evidence trail for every money, auth and admin action (rule 15).
 * These tests assert the two properties that make it evidence rather than decoration:
 * the database refuses to change it, and altering it anyway is detectable.
 */
describe('audit log (integration)', () => {
  let pool: Pool;
  let audit: AuditService;
  let chain: AuditChainService;

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    audit = new AuditService(pool);
    chain = new AuditChainService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('appends entries and verifies the chain', async () => {
    await audit.append({ actorType: 'system', action: 'test.append', payload: { n: 1 } });
    await audit.append({ actorType: 'system', action: 'test.append', payload: { n: 2 } });

    const result = await chain.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(2);
  });

  it('REJECTS UPDATE at the database level, not in application code', async () => {
    const id = await audit.append({ actorType: 'system', action: 'test.immutable' });
    await expect(
      pool.query('UPDATE audit.audit_log SET action = $1 WHERE id = $2', ['tampered', id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('REJECTS DELETE at the database level', async () => {
    const id = await audit.append({ actorType: 'system', action: 'test.immutable' });
    await expect(pool.query('DELETE FROM audit.audit_log WHERE id = $1', [id])).rejects.toThrow(
      /append-only/i,
    );
  });

  it('does not call a chain "verified" when it only read a prefix of it', async () => {
    // The bug this pins down: verification reads a bounded window, and it used to return
    // `valid: true` after filling that window — so once the audit log grew past it, a
    // scheduled check would report an intact chain while never looking at anything
    // recent. Tampering with a recent row would have gone undetected forever. `valid` now
    // means "nothing I read was wrong" and `complete` means "I read all of it"; a caller
    // must require both.
    await audit.append({ actorType: 'system', action: 'test.window' });
    await audit.append({ actorType: 'system', action: 'test.window' });

    const window = await chain.verify({ limit: 1 });
    expect(window.valid).toBe(true);
    expect(window.complete).toBe(false);
    expect(window.nextFromSeq).toBeGreaterThan(0);

    // Paging with the same small window still walks the whole chain, and links each
    // window to the next rather than trusting the boundary row.
    const full = await chain.verifyAll({ windowSize: 3 });
    expect(full.valid).toBe(true);
    expect(full.complete).toBe(true);
    expect(full.checked).toBeGreaterThan(3);
  });

  it('detects tampering that bypasses the trigger', async () => {
    // Tamper with **this test's own row**, found by id, and put back the exact bytes that
    // were there.
    //
    // An earlier version took `ORDER BY seq DESC LIMIT 1` and assumed it was its own
    // append. It usually was — until an instance started doing scheduled work, at which
    // point a background formation could land a row in between. The test then "restored"
    // somebody else's row to a payload it had invented, permanently breaking the local
    // chain: a tamper-detection test quietly tampering with the audit log. Identify the
    // row, capture its original bytes, restore those.
    const id = await audit.append({
      actorType: 'system',
      action: 'test.tamper',
      payload: { amount: 100 },
    });

    const before = await pool.query<{ seq: string; payload: unknown }>(
      'SELECT seq, payload FROM audit.audit_log WHERE id = $1',
      [id],
    );
    const seq = Number(before.rows[0]!.seq);
    const originalPayload = JSON.stringify(before.rows[0]!.payload);

    // Simulate an attacker with enough privilege to disable the trigger — the scenario
    // hash-chaining exists for. The chain must still expose the edit.
    const withTriggerOff = async (work: () => Promise<void>) => {
      await pool.query('ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_mutation');
      try {
        await work();
      } finally {
        await pool.query('ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_mutation');
      }
    };

    await withTriggerOff(async () => {
      await pool.query(
        `UPDATE audit.audit_log SET payload = '{"amount": 999999}'::jsonb WHERE id = $1`,
        [id],
      );
    });

    try {
      const result = await chain.verifyAll();
      expect(result.valid).toBe(false);
      expect(result.brokenAtSeq).toBe(seq);
      expect(result.reason).toMatch(/tampered|does not match/i);
    } finally {
      // Restore even if an assertion above failed: a failing test must not leave the
      // chain broken for every run after it.
      await withTriggerOff(async () => {
        await pool.query('UPDATE audit.audit_log SET payload = $2::jsonb WHERE id = $1', [
          id,
          originalPayload,
        ]);
      });
    }

    const restored = await chain.verifyAll();
    expect(restored.valid).toBe(true);
    expect(restored.complete).toBe(true);
  });

  it('rolls the audit entry back with its caller transaction', async () => {
    const before = await countRows(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await audit.append({ actorType: 'system', action: 'test.rollback' }, client);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // An action that never happened must leave no evidence that it did.
    expect(await countRows(pool)).toBe(before);
  });

  it('keeps the chain intact under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.append({ actorType: 'system', action: 'test.concurrent', payload: { i } }),
      ),
    );
    expect((await chain.verifyAll()).valid).toBe(true);
  });
});

async function countRows(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM audit.audit_log');
  return Number(rows[0]!.count);
}
