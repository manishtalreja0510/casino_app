import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * Redis is cache, locks, queues, rate limiting and (from P5) the Socket.IO adapter.
 * It NEVER holds financial truth (rule 7, ADR-005): losing it may interrupt play,
 * never money. Every consumer must therefore tolerate it being unavailable.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 2,
          // Fail fast rather than queueing commands while down — callers fall back
          // to PostgreSQL or to safe defaults instead of hanging on a dead cache.
          enableOfflineQueue: false,
          lazyConnect: false,
          retryStrategy: (times) => Math.min(times * 200, 5_000),
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  /** How long boot waits for the connection before continuing in a degraded state. */
  private static readonly readyTimeoutMs = 5_000;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    // An unhandled 'error' event on ioredis crashes the process; log and carry on,
    // because Redis being down must degrade the platform, not kill it.
    this.redis.on('error', (error: Error) => this.logger.warn(`redis: ${error.message}`));
  }

  /**
   * Waits (briefly) for the connection before the app starts serving.
   *
   * The offline queue is disabled so that real traffic fails fast instead of hanging on a
   * dead cache — but that also means commands issued in the first moments after boot are
   * rejected outright while the socket is still connecting. Waiting here removes that
   * window for every consumer, rather than making each one handle it.
   *
   * Bounded and non-fatal: if Redis is genuinely down the app still starts, degraded —
   * flags fall back to PostgreSQL and readiness reports it (rule 7).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.redis.status === 'ready') return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn(
          `redis not ready within ${RedisModule.readyTimeoutMs}ms; starting in a degraded state`,
        );
        resolve();
      }, RedisModule.readyTimeoutMs);

      this.redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    this.logger.log('redis disconnected');
  }
}
