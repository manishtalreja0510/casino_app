import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PlatformModule } from './platform/platform.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './wallet/wallet.module';
import { RealtimeModule } from './realtime/realtime.module';
import { GameEngineModule } from './game-engine/game-engine.module';
import { MatchmakingModule } from './matchmaking/matchmaking.module';
import { CrashModule } from './games/crash/crash.module';
import { PokerModule } from './games/poker/poker.module';
import { RgModule } from './responsible-gaming/rg.module';
import { RiskModule } from './risk/risk.module';
import { TraceIdMiddleware } from './platform/logging/trace-id.middleware';
import { MaintenanceMiddleware } from './platform/maintenance/maintenance.middleware';

/**
 * Root module. Domain modules (auth, users, wallet, game-engine, …) are added from P3
 * onward per docs/01-architecture/backend-architecture.md — they plug into the platform
 * chassis and own only their own tables (rule 20).
 */
@Module({
  imports: [
    AppConfigModule,
    PlatformModule,
    HealthModule,
    AuthModule,
    WalletModule,
    RealtimeModule,
    GameEngineModule,
    MatchmakingModule,
    CrashModule,
    PokerModule,
    RgModule,
    RiskModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters: a trace id must exist before anything can log or fail with one.
    //
    // `'{*path}'`, not `'*'`: Express 5 / path-to-regexp v8 dropped bare wildcards, and
    // Nest only auto-converts them while warning on every boot.
    consumer.apply(TraceIdMiddleware, MaintenanceMiddleware).forRoutes('{*path}');
  }
}
