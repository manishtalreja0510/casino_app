import { Module, type OnModuleInit } from '@nestjs/common';
import { GameEngineModule } from '../../game-engine/game-engine.module';
import { GameRegistry } from '../../game-engine/game.registry';
import { MatchmakingModule } from '../../matchmaking/matchmaking.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WalletModule } from '../../wallet/wallet.module';
import { CrashModule } from '../crash/crash.module';
import { PokerController } from './poker.controller';
import { PokerRepository } from './poker.repository';
import { PokerService } from './poker.service';
import { poker } from './poker.game';

/**
 * Poker (P9) — tables, seats and the deal loop around a `GameDefinition` hand.
 *
 * Imports `CrashModule` for one thing only: the Redis lease that decides which instance
 * drives a table's deal loop. It is the same problem crash rounds have (work that happens
 * because time passed rather than because someone asked), so it is the same primitive
 * rather than a second one that drifts.
 */
@Module({
  imports: [GameEngineModule, MatchmakingModule, RealtimeModule, WalletModule, CrashModule],
  controllers: [PokerController],
  providers: [PokerService, PokerRepository],
  exports: [PokerService, PokerRepository],
})
export class PokerModule implements OnModuleInit {
  constructor(private readonly registry: GameRegistry) {}

  onModuleInit(): void {
    this.registry.register(poker as never);
  }
}
