import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { HealthResponse, HealthStatus, ReadinessResponse } from '@casino/contracts';
import { PG_POOL } from '../platform/database/database.module';
import { REDIS } from '../platform/redis/redis.module';

/** Version reported by the health endpoint; stamped by the build in CI (P13). */
export const APP_VERSION = '0.0.0';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Liveness: is the process itself healthy? Deliberately checks no dependencies —
   * a database outage must not cause orchestrators to kill otherwise-fine processes.
   */
  liveness(): HealthResponse {
    return {
      status: 'ok',
      version: APP_VERSION,
      environment: this.config.get<string>('APP_ENV') ?? 'dev',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * Readiness: can this instance serve traffic? PostgreSQL is required — without truth
   * we serve nothing. Redis being down is `degraded`, not `down`: flags fall back to the
   * database and to safe defaults, so the platform still functions (rule 7, ADR-005).
   */
  async readiness(): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);

    const status: HealthStatus =
      postgres === 'down' ? 'down' : redis === 'down' ? 'degraded' : 'ok';

    return {
      status,
      dependencies: [
        { name: 'postgres', status: postgres },
        { name: 'redis', status: redis },
      ],
    };
  }

  private async checkPostgres(): Promise<HealthStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'ok';
    } catch (error) {
      this.logger.warn(`postgres check failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return 'down';
    }
  }

  private async checkRedis(): Promise<HealthStatus> {
    try {
      return (await this.redis.ping()) === 'PONG' ? 'ok' : 'degraded';
    } catch {
      // The client refuses commands while still connecting (offline queue is disabled so
      // that real traffic fails fast rather than hanging). At startup that is not an
      // outage, so give the connection a brief grace before calling Redis down —
      // otherwise every instance reports degraded for its first second of life.
      if (await this.waitForRedisReady(2_000)) {
        try {
          return (await this.redis.ping()) === 'PONG' ? 'ok' : 'degraded';
        } catch {
          return 'down';
        }
      }
      this.logger.warn('redis check failed: client not ready');
      return 'down';
    }
  }

  private waitForRedisReady(timeoutMs: number): Promise<boolean> {
    if (this.redis.status === 'ready') return Promise.resolve(true);
    if (typeof this.redis.once !== 'function') return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.redis.once('ready', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
