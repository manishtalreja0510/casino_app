import type { Pool, PoolClient } from 'pg';

/**
 * Runs `work` inside a single database transaction.
 *
 * Every financial operation is atomic and concurrency-safe (rule 6), which means all of
 * its writes — including its audit entry (rule 15) — share one transaction: if the
 * operation rolls back, its audit row must vanish with it rather than record something
 * that never happened.
 *
 * The client is passed to `work` so callers can issue `SELECT … FOR UPDATE` in a
 * consistent lock order. `isolationLevel` is available for the reconciliation-critical
 * paths that P4 introduces.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: { isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.isolationLevel) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
