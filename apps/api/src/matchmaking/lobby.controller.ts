import { Body, Controller, Delete, Get, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { MatchmakingService } from './matchmaking.service';
import { validate } from '../auth/dto/validate';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';

const queueSchema = z.object({ tierId: z.string().min(1).max(80) });

@Controller('lobby')
export class LobbyController {
  constructor(private readonly matchmaking: MatchmakingService) {}

  @Get()
  async lobby() {
    return this.matchmaking.lobby();
  }

  @Post('queue')
  async joinQueue(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(queueSchema, body);
    return this.matchmaking.joinQueue(request.auth!.userId, input.tierId);
  }

  @Delete('queue')
  async leaveQueue(@Query('tierId') tierId: string, @Req() request: AuthenticatedRequest) {
    return this.matchmaking.leaveQueue(request.auth!.userId, String(tierId ?? ''));
  }

  /** Also refreshes the caller's queue TTL — the client polls this while waiting. */
  @Get('queue')
  async queueStatus(@Query('tierId') tierId: string, @Req() request: AuthenticatedRequest) {
    return this.matchmaking.queueStatus(request.auth!.userId, String(tierId ?? ''));
  }
}
