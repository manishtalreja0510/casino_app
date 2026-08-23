import { Module } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingRepository } from './matchmaking.repository';
import { QueueService } from './queue.service';
import { LobbyController } from './lobby.controller';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { GameEngineModule } from '../game-engine/game-engine.module';

@Module({
  imports: [AuthModule, WalletModule, RealtimeModule, GameEngineModule],
  controllers: [LobbyController],
  providers: [MatchmakingService, MatchmakingRepository, QueueService],
  exports: [MatchmakingService, MatchmakingRepository, QueueService],
})
export class MatchmakingModule {}
