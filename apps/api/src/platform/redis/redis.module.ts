import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
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
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    // An unhandled 'error' event on ioredis crashes the process; log and carry on,
    // because Redis being down must degrade the platform, not kill it.
    this.redis.on('error', (error: Error) => this.logger.warn(`redis: ${error.message}`));
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    this.logger.log('redis disconnected');
  }
}
