import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimiter, RateLimitClass } from '../platform/rate-limit/rate-limit';
import { RateLimitedError } from '../platform/errors/domain-error';

/**
 * Auth-endpoint rate limiting — the credential-stuffing surface, so the strictest class
 * (`docs/04-security/network-security.md`).
 *
 * Two independent buckets, because either alone is trivially evaded:
 *  - per IP: stops one host hammering many accounts,
 *  - per identifier: stops a distributed attack converging on one account.
 */
@Injectable()
export class AuthRateLimitService {
  constructor(private readonly limiter: RateLimiter) {}

  async check(request: Request, identifier?: string): Promise<void> {
    const ip = request.ip ?? 'unknown';
    const buckets = [`auth:ip:${ip}`];
    if (identifier) buckets.push(`auth:id:${identifier.toLowerCase()}`);

    for (const bucket of buckets) {
      const result = await this.limiter.consume(bucket, RateLimitClass.AUTH);
      if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    }
  }
}
