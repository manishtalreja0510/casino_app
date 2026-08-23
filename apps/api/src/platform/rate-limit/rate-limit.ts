import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export interface RateLimitPolicy {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Endpoint classes (network-security.md). Auth is strictest because it is the
 * credential-stuffing surface; financial mutations are next. Tuned in P3/P4 against
 * real traffic shapes, and again under load in P14.
 */
export const RateLimitClass = {
  AUTH: { limit: 10, windowSeconds: 60 },
  FINANCIAL: { limit: 30, windowSeconds: 60 },
  DEFAULT: { limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window counter in Redis, keyed per identity+class.
 *
 * Deliberately a counter rather than a token bucket for now: it is one round trip, its
 * failure mode is obvious, and the edge (WAF) carries the volumetric load. The
 * burst-smoothing of a bucket matters once real traffic exists — revisit in P14.
 *
 * **Failure policy:** if Redis is unavailable the limiter fails OPEN. That is a
 * deliberate trade-off — availability of the platform over strictness of a rate limit —
 * and it is safe only because rate limiting is defence in depth here, never the control
 * that protects money or authorisation. Financial correctness is protected by
 * idempotency keys and database constraints (rules 5–6), which do not depend on Redis.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(identity: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / 1000 / policy.windowSeconds);
    const key = `rl:${identity}:${window}`;

    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, policy.windowSeconds);
      }
      const remaining = Math.max(0, policy.limit - count);
      return {
        allowed: count <= policy.limit,
        remaining,
        retryAfterSeconds: count <= policy.limit ? 0 : policy.windowSeconds,
      };
    } catch (error) {
      this.logger.warn(
        `rate limiter unavailable (${error instanceof Error ? error.message : 'unknown'}); allowing request`,
      );
      return { allowed: true, remaining: policy.limit, retryAfterSeconds: 0 };
    }
  }
}
