import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

/**
 * Root module. Domain modules (auth, users, wallet, game-engine, ...) are added
 * from P1 onward per docs/01-architecture/backend-architecture.md.
 */
@Module({
  imports: [AppConfigModule, HealthModule],
})
export class AppModule {}
