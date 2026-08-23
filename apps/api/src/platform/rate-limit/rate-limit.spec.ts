import type Redis from 'ioredis';
import { RateLimitClass, RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
  it('allows up to the limit and blocks beyond it', async () => {
    let count = 0;
    const redis = {
      incr: () => Promise.resolve(++count),
      expire: () => Promise.resolve(1),
    } as unknown as Redis;
    const limiter = new RateLimiter(redis);

    const policy = { limit: 3, windowSeconds: 60 };
    expect((await limiter.consume('ip:1.2.3.4', policy)).allowed).toBe(true);
    expect((await limiter.consume('ip:1.2.3.4', policy)).allowed).toBe(true);
    expect((await limiter.consume('ip:1.2.3.4', policy)).allowed).toBe(true);

    const blocked = await limiter.consume('ip:1.2.3.4', policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    expect(blocked.remaining).toBe(0);
  });

  it('keeps auth the strictest class', () => {
    expect(RateLimitClass.AUTH.limit).toBeLessThan(RateLimitClass.FINANCIAL.limit);
    expect(RateLimitClass.FINANCIAL.limit).toBeLessThan(RateLimitClass.DEFAULT.limit);
  });

  it('fails OPEN when Redis is unavailable — documented trade-off, see the class doc', async () => {
    const redis = { incr: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const result = await new RateLimiter(redis).consume('ip:1.2.3.4', RateLimitClass.AUTH);
    expect(result.allowed).toBe(true);
  });
});
