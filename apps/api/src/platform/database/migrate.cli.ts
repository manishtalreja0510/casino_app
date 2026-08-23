/**
 * Migration CLI: `pnpm --filter @casino/api migrate`.
 *
 * Migrations run as a separate step BEFORE the application rolls out (ci-cd.md), never
 * automatically at boot: an app that migrates on startup races with itself across
 * instances and turns a bad migration into an outage of every replica at once.
 */
import { Pool } from 'pg';
import { Logger } from '@nestjs/common';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const logger = new Logger('Migrate');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const applied = await runMigrations(pool, logger);
    logger.log(applied.length === 0 ? 'no new migrations' : `applied ${applied.length} migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  new Logger('Migrate').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
