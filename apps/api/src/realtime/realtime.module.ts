import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';
import { TicketService } from './ticket.service';
import { SequencerService } from './sequencer.service';
import { PresenceService } from './presence.service';
import { TimerService } from './timer.service';
import { AuthModule } from '../auth/auth.module';
import { MatchmakingRepository } from '../matchmaking/matchmaking.repository';

/**
 * Realtime module (P5). Exports the broadcast surface and the timer service; the gateway
 * itself stays internal so nothing outside emits to sockets un-sequenced.
 */
@Module({
  imports: [AuthModule],
  controllers: [RealtimeController],
  providers: [
    RealtimeGateway,
    RealtimeService,
    TicketService,
    SequencerService,
    PresenceService,
    TimerService,
    // The gateway checks match rosters when authorising a room join. Provided directly
    // rather than importing MatchmakingModule, which would create a cycle:
    // matchmaking -> game-engine -> realtime -> matchmaking.
    MatchmakingRepository,
  ],
  exports: [RealtimeService, SequencerService, TimerService, PresenceService],
})
export class RealtimeModule {}
