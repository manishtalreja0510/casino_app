import { Logger, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { EngineService } from './engine.service';
import { GameRegistry } from './game.registry';
import { MatchRepository } from './match.repository';
import { RngService } from './rng.service';
import { RecoveryService } from './recovery.service';
import { GameEngineController } from './game-engine.controller';
import { coinDuel } from './games/coin-duel.game';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

/**
 * Game engine (P6). Games register here; the shipped ones arrive in P8 and P9.
 */
@Module({
  imports: [AuthModule, WalletModule, RealtimeModule],
  controllers: [GameEngineController],
  providers: [EngineService, GameRegistry, MatchRepository, RngService, RecoveryService],
  exports: [EngineService, GameRegistry, RngService],
})
export class GameEngineModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(GameEngineModule.name);

  constructor(
    private readonly registry: GameRegistry,
    private readonly recovery: RecoveryService,
  ) {}

  onModuleInit(): void {
    // The reference game is a development fixture. It is registered unconditionally
    // because it is also what the conformance suite runs against; it is never exposed in
    // a lobby, and P8/P9 ship the real games.
    this.registry.register(coinDuel as never);
  }

  /**
   * Sweeps matches left mid-play by a crash, at startup.
   *
   * Until P7 matches were only created by tests, so this could wait. Now that matchmaking
   * seats real players, a process that restarts mid-match must resume or void them —
   * leaving stakes in escrow with nobody looking is not an option (rule 9).
   *
   * Failures are logged, never fatal: an instance that cannot recover must still come up
   * and serve, or one bad match would keep the platform down.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // RecoveryService logs its own summary; dumping every match id here was unreadable.
      await this.recovery.recoverAll();
    } catch (error) {
      this.logger.error(
        `startup recovery failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
