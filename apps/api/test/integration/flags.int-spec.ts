import type { Pool } from 'pg';
import Redis from 'ioredis';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { ensureMigrated, testPool, TEST_REDIS_URL } from './db';

describe('feature flags (integration)', () => {
  let pool: Pool;
  let redis: Redis;
  let flags: FlagsService;

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    flags = new FlagsService(pool, redis);
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('seeds the compliance gate OFF (rule 11)', async () => {
    expect(await flags.isRealMoneyEnabled()).toBe(false);
  });

  it('marks the compliance gate as requiring four eyes', async () => {
    expect(await flags.requiresFourEyes(FlagKey.REAL_MONEY_ENABLED)).toBe(true);
  });

  it('reads through the cache and invalidates on write', async () => {
    const key = 'test.flag.roundtrip';
    await flags.set(key, true, 'integration-test');
    expect(await flags.isEnabled(key)).toBe(true);

    await flags.set(key, false, 'integration-test');
    // Without invalidation this would still read `true` from the cache.
    expect(await flags.isEnabled(key)).toBe(false);

    await pool.query('DELETE FROM platform.feature_flags WHERE key = $1', [key]);
    await flags.invalidate(key);
  });

  it('returns the safe default for a flag nobody has defined', async () => {
    expect(await flags.isEnabled('nonexistent.flag')).toBe(false);
  });

  it('FAILS CLOSED when both cache and database are unreachable', async () => {
    const deadPool = { query: () => Promise.reject(new Error('connection refused')) } as unknown as Pool;
    const deadRedis = {
      get: () => Promise.reject(new Error('connection refused')),
      set: () => Promise.reject(new Error('connection refused')),
      del: () => Promise.reject(new Error('connection refused')),
    } as unknown as Redis;
    const offline = new FlagsService(deadPool, deadRedis);

    // The critical property: an unreachable flag store must never enable real money.
    expect(await offline.isRealMoneyEnabled()).toBe(false);
    expect(await offline.isEnabled(FlagKey.DEV_DIRECT_CREDIT)).toBe(false);
    // And must not self-inflict an outage by claiming maintenance mode.
    expect(await offline.isEnabled(FlagKey.MAINTENANCE_MODE)).toBe(false);
  });

  it('falls back to the database when only the cache is down', async () => {
    const deadRedis = {
      get: () => Promise.reject(new Error('cache down')),
      set: () => Promise.reject(new Error('cache down')),
      del: () => Promise.reject(new Error('cache down')),
    } as unknown as Redis;
    const cacheless = new FlagsService(pool, deadRedis);
    expect(await cacheless.isEnabled(FlagKey.MAINTENANCE_MODE)).toBe(false);
    expect(await cacheless.requiresFourEyes(FlagKey.REAL_MONEY_ENABLED)).toBe(true);
  });
});
