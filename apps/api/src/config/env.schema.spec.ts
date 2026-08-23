import { ConfigValidationError, validateEnv } from './env.schema';

describe('environment validation (fail fast)', () => {
  const base = { NODE_ENV: 'development', APP_ENV: 'dev', PORT: '3000' };

  it('accepts a valid dev environment and coerces PORT to a number', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.APP_ENV).toBe('dev');
  });

  it('applies defaults when optional values are absent', () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ENV).toBe('dev');
    expect(env.PORT).toBe(3000);
  });

  it('rejects an unknown APP_ENV rather than guessing', () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'production-ish' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv({ ...base, PORT: 'not-a-port' })).toThrow(ConfigValidationError);
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(ConfigValidationError);
  });

  it('requires datastore URLs outside dev', () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'staging' })).toThrow(/DATABASE_URL/);
    expect(() =>
      validateEnv({
        ...base,
        APP_ENV: 'staging',
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        REDIS_URL: 'redis://h:6379',
      }),
    ).not.toThrow();
  });

  it('never echoes the offending value in the error message', () => {
    try {
      validateEnv({ ...base, DATABASE_URL: 'postgresql-not-a-url-with-secret-hunter2' });
      fail('expected validation to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
