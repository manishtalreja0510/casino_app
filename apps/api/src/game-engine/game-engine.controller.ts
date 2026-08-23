import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { EngineService } from './engine.service';
import { validate } from '../auth/dto/validate';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';

const actionSchema = z.object({
  type: z.string().min(1).max(40),
  payload: z.record(z.unknown()).optional(),
});

const createMatchSchema = z.object({
  gameCode: z.string().min(1).max(40),
  /** Opponents; the caller is always seated first. */
  opponentUserIds: z.array(z.string().uuid()).min(1).max(9),
  stake: z.number().int().min(0),
});

@Controller('games')
export class GameEngineController {
  constructor(private readonly engine: EngineService) {}

  /**
   * Creates a match directly. This is the seam P7 replaces with real matchmaking — until
   * then it is how a match comes into being for development and tests.
   */
  @Post('matches')
  async createMatch(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(createMatchSchema, body);
    return this.engine.createMatch({
      gameCode: input.gameCode,
      stake: input.stake,
      players: [
        { userId: request.auth!.userId },
        ...input.opponentUserIds.map((userId) => ({ userId })),
      ],
    });
  }

  /** The caller's own view. A non-participant is refused rather than shown a filtered blob. */
  @Get('matches/:id')
  async view(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.engine.viewFor(id, request.auth!.userId);
  }

  @Post('matches/:id/actions')
  async act(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(actionSchema, body);
    await this.engine.submitAction(id, {
      type: input.type,
      userId: request.auth!.userId,
      ...(input.payload ? { payload: input.payload } : {}),
    });
    return this.engine.viewFor(id, request.auth!.userId);
  }
}
