import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RgController } from './rg.controller';
import { RgRepository } from './rg.repository';
import { RgService } from './rg.service';

/**
 * Responsible gaming (P10).
 *
 * Imported by the wallet rather than the other way round: enforcement lives at the money
 * boundary (ADR-026), and RG needs nothing from the wallet — usage is metered by the
 * wallet calling in, so there is no cycle and no temptation to read another module's
 * tables.
 */
@Module({
  // Realtime, for one thing only: pushing a reality check to a player who is connected.
  // The direction is safe — realtime knows nothing about responsible gaming — and the
  // alternative, a client that decides when to show its own reality check, is not a
  // control at all.
  imports: [AuthModule, RealtimeModule],
  controllers: [RgController],
  providers: [RgService, RgRepository],
  exports: [RgService, RgRepository],
})
export class RgModule {}
