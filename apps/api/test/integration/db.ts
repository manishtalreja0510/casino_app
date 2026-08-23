import { Pool } from 'pg';
import { runMigrations } from '../../src/platform/database/migrator';
import { Logger } from '@nestjs/common';

/**
 * Integration tests run against a REAL PostgreSQL and Redis — money and audit paths are
 * never tested against a mock or a different engine (testing-strategy.md).
 *
 * Connection comes from the environment: the local dev stack for developers, service
 * containers in CI. See PHASE-01 §17 for why this is not Testcontainers.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://casino_dev:casino_dev_local_only@127.0.0.1:5432/casino_dev';

export const TEST_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export function testPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}

let migrated = false;

/** Applies migrations once per test process. */
export async function ensureMigrated(pool: Pool): Promise<void> {
  if (migrated) return;
  const silent = new Logger('test');
  silent.log = () => undefined;
  await runMigrations(pool, silent);
  migrated = true;
}
