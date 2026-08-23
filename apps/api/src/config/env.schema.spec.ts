import { ConfigValidationError, validateEnv } from './env.schema';

/**
 * Since P1 the datastores are wired, so DATABASE_URL and REDIS_URL are required in every
 * environment — including dev. A missing datastore must fail at boot, not at first query.
 */
const base = {
  NODE_ENV: 'development',
  APP_ENV: 'dev',
  PORT: '3000',
  DATABASE_URL: 'postgresql://casino_dev:local@127.0.0.1:5432/casino_dev',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('environment validation (fail fast)', () => {
  it('accepts a valid environment and coerces numbers', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.APP_ENV).toBe('dev');
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('applies defaults for genuinely optional values', () => {
    const env = validateEnv({ DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL });
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ENV).toBe('dev');
    expect(env.PORT).toBe(3000);
  });

  it('requires DATABASE_URL in every environment, dev included', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = base;
    expect(() => validateEnv(withoutDb)).toThrow(ConfigValidationError);
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('requires REDIS_URL in every environment', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = base;
    expect(() => validateEnv(withoutRedis)).toThrow(/REDIS_URL/);
  });

  it('rejects a malformed datastore URL rather than failing later at connect time', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'not-a-url' })).toThrow(ConfigValidationError);
  });

  it('rejects an unknown APP_ENV rather than guessing', () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'production-ish' })).toThrow(ConfigValidationError);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv({ ...base, PORT: 'not-a-port' })).toThrow(ConfigValidationError);
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(ConfigValidationError);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => validateEnv({ ...base, LOG_LEVEL: 'chatty' })).toThrow(ConfigValidationError);
  });

  it('never echoes the offending value in the error message (rule 15)', () => {
    try {
      validateEnv({ ...base, DATABASE_URL: 'postgres-not-a-url-with-password-hunter2' });
      fail('expected validation to throw');
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
