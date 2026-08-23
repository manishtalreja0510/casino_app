import { Module, type OnModuleInit } from '@nestjs/common';
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
export class GameEngineModule implements OnModuleInit {
  constructor(private readonly registry: GameRegistry) {}

  onModuleInit(): void {
    // The reference game is a development fixture. It is registered unconditionally
    // because it is also what the conformance suite runs against; it is never exposed in
    // a lobby, and P8/P9 ship the real games.
    this.registry.register(coinDuel as never);
  }
}
