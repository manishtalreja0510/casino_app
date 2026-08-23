import { Controller, Post, Req } from '@nestjs/common';
import { TicketService } from './ticket.service';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';

@Controller('realtime')
export class RealtimeController {
  constructor(private readonly tickets: TicketService) {}

  /**
   * Issues a single-use WebSocket ticket for the caller's session.
   *
   * Authenticated like any other endpoint, so the socket layer inherits the same identity
   * checks rather than inventing its own.
   */
  @Post('ticket')
  async issue(@Req() request: AuthenticatedRequest) {
    return this.tickets.issue({
      userId: request.auth!.userId,
      sessionId: request.auth!.sessionId,
      ...(request.auth!.deviceId ? { deviceId: request.auth!.deviceId } : {}),
    });
  }
}
