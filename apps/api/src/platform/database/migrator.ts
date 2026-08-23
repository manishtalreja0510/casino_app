import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Logger } from '@nestjs/common';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * SQL-first migration runner (ADR-020).
 *
 * Migrations are plain `.sql` files applied in filename order, each inside its own
 * transaction, and recorded in `platform.schema_migrations` with a checksum. Re-running
 * is a no-op; editing an already-applied migration is an error rather than a silent skip,
 * because a changed migration means environments have diverged.
 */
export async function runMigrations(pool: Pool, logger = new Logger('Migrator')): Promise<string[]> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM platform.schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied. Migrations are immutable — ` +
            'add a new migration instead of editing history.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO platform.schema_migrations (name, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      logger.log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}
