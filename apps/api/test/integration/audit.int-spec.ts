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

    const result = await chain.verify();
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

  it('detects tampering that bypasses the trigger', async () => {
    await audit.append({ actorType: 'system', action: 'test.tamper', payload: { amount: 100 } });
    const { rows } = await pool.query<{ seq: string }>(
      'SELECT seq FROM audit.audit_log ORDER BY seq DESC LIMIT 1',
    );
    const seq = Number(rows[0]!.seq);

    // Simulate an attacker with enough privilege to disable the trigger — the scenario
    // hash-chaining exists for. The chain must still expose the edit.
    await pool.query('ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_mutation');
    try {
      await pool.query(`UPDATE audit.audit_log SET payload = '{"amount": 999999}'::jsonb WHERE seq = $1`, [seq]);
    } finally {
      await pool.query('ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_mutation');
    }

    const result = await chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(seq);
    expect(result.reason).toMatch(/tampered|does not match/i);

    // Restore so later runs start from a valid chain.
    await pool.query('ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_mutation');
    await pool.query(`UPDATE audit.audit_log SET payload = '{"amount": 100}'::jsonb WHERE seq = $1`, [seq]);
    await pool.query('ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_mutation');
    expect((await chain.verify()).valid).toBe(true);
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
    expect((await chain.verify()).valid).toBe(true);
  });
});

async function countRows(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM audit.audit_log');
  return Number(rows[0]!.count);
}
