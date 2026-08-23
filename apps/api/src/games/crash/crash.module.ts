import { Module, type OnModuleInit } from '@nestjs/common';
import { GameEngineModule } from '../../game-engine/game-engine.module';
import { GameRegistry } from '../../game-engine/game.registry';
import { MatchmakingModule } from '../../matchmaking/matchmaking.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WalletModule } from '../../wallet/wallet.module';
import { CrashController } from './crash.controller';
import { CrashService } from './crash.service';
import { RoundLeaderService } from './round-leader.service';
import { crash } from './crash.game';

/**
 * Crash (P8) — the first shipped game, and the test of whether ADR-009's contract really
 * makes a game a plug-in. It registers a definition, orchestrates rounds, and owns no
 * tables of its own; the engine, the wallet and the realtime layer are untouched by the
 * fact that this particular game exists.
 */
@Module({
  imports: [GameEngineModule, MatchmakingModule, RealtimeModule, WalletModule],
  controllers: [CrashController],
  providers: [CrashService, RoundLeaderService],
  exports: [CrashService],
})
export class CrashModule implements OnModuleInit {
  constructor(private readonly registry: GameRegistry) {}

  onModuleInit(): void {
    this.registry.register(crash as never);
  }
}
