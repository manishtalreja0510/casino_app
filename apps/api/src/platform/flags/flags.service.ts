import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { safeDefaultFor } from './flag-keys';

const CACHE_PREFIX = 'flag:';
const CACHE_TTL_SECONDS = 30;

/**
 * Feature flags and kill-switches (backend-architecture.md §8).
 *
 * Read path: Redis cache → PostgreSQL (truth) → safe default. The last step is the
 * important one: if both stores are unreachable the answer is the SAFE value, never a
 * cached optimistic guess and never an exception that a caller might swallow into
 * "enabled" (rule 16).
 */
@Injectable()
export class FlagsService {
  private readonly logger = new Logger(FlagsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async isEnabled(key: string): Promise<boolean> {
    const cached = await this.readCache(key);
    if (cached !== null) return cached;

    try {
      const { rows } = await this.pool.query<{ value_bool: boolean }>(
        'SELECT value_bool FROM platform.feature_flags WHERE key = $1',
        [key],
      );
      const row = rows[0];
      if (row === undefined) {
        // An unknown flag is not an error: it is a flag nobody has created yet,
        // and it must behave as its safe default.
        this.logger.warn(`flag "${key}" is not defined; using safe default`);
        return safeDefaultFor(key);
      }
      await this.writeCache(key, row.value_bool);
      return row.value_bool;
    } catch (error) {
      this.logger.error(
        `flag "${key}" unreadable (${error instanceof Error ? error.message : 'unknown'}); ` +
          'failing closed to safe default',
      );
      return safeDefaultFor(key);
    }
  }

  /** True only when real money is positively enabled (rule 11). */
  async isRealMoneyEnabled(): Promise<boolean> {
    return this.isEnabled('compliance.real_money_enabled');
  }

  /**
   * Sets a flag and invalidates the cache. Callers are responsible for the audit entry
   * and, where `requires_four_eyes` is set, for the approval flow (enforced in P12).
   */
  async set(key: string, value: boolean, updatedBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform.feature_flags (key, value_bool, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value_bool = EXCLUDED.value_bool,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [key, value, updatedBy],
    );
    await this.invalidate(key);
  }

  async requiresFourEyes(key: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ requires_four_eyes: boolean }>(
      'SELECT requires_four_eyes FROM platform.feature_flags WHERE key = $1',
      [key],
    );
    return rows[0]?.requires_four_eyes ?? false;
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.redis.del(`${CACHE_PREFIX}${key}`);
    } catch {
      // A stale cache entry expires within CACHE_TTL_SECONDS anyway.
    }
  }

  private async readCache(key: string): Promise<boolean | null> {
    try {
      const value = await this.redis.get(`${CACHE_PREFIX}${key}`);
      if (value === '1') return true;
      if (value === '0') return false;
      return null;
    } catch {
      return null; // Cache unavailable: fall through to the database.
    }
  }

  private async writeCache(key: string, value: boolean): Promise<void> {
    try {
      await this.redis.set(`${CACHE_PREFIX}${key}`, value ? '1' : '0', 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Caching is an optimisation; failing to cache must not fail the read.
    }
  }
}
