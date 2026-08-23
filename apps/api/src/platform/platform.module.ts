import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { LoggingModule } from './logging/logging.module';
import { FlagsModule } from './flags/flags.module';
import { AuditModule } from './audit/audit.module';
import { JobsModule } from './jobs/jobs.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';

/**
 * The platform chassis: everything a domain module is entitled to assume exists.
 * Domain modules (auth, wallet, game-engine, …) import nothing from here explicitly —
 * these are global providers — and own only their own tables (rule 20).
 */
@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    LoggingModule,
    FlagsModule,
    AuditModule,
    JobsModule,
    RateLimitModule,
  ],
  exports: [
    DatabaseModule,
    RedisModule,
    LoggingModule,
    FlagsModule,
    AuditModule,
    JobsModule,
    RateLimitModule,
  ],
})
export class PlatformModule {}
