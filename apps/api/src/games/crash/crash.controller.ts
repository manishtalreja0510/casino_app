import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { crashRoundRoom } from '@casino/contracts';
import { validate } from '../../auth/dto/validate';
import type { AuthenticatedRequest } from '../../auth/guards/access-token.guard';
import { CrashService } from './crash.service';

const placeBetSchema = z.object({
  /** Integer minor units. Bounds are the tier's, and are enforced server-side. */
  amount: z.number().int().min(0),
  autoCashOutX100: z.number().int().min(101).optional(),
});

/**
 * Crash's HTTP surface.
 *
 * Thin by design: every one of these is a request the server may refuse, and none of them
 * carries a number the server trusts. The bet amount is validated against the tier, the
 * bettor is taken from the access token rather than the body, and a cash-out carries no
 * multiplier at all — the server prices it.
 */
@Controller('games/crash')
export class CrashController {
  constructor(private readonly crash: CrashService) {}

  /** The current round for a tier, plus where to subscribe for live updates. */
  @Get('rounds/:tierId')
  async round(@Param('tierId') tierId: string) {
    const round = await this.crash.roundFor(tierId);
    return {
      ...round,
      room: crashRoundRoom(tierId),
      history: this.crash.recentOutcomes(tierId),
    };
  }

  @Post('rounds/:tierId/bets')
  async bet(@Param('tierId') tierId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(placeBetSchema, body);
    return this.crash.placeBet({
      userId: request.auth!.userId,
      tierId,
      amount: input.amount,
      ...(input.autoCashOutX100 === undefined ? {} : { autoCashOutX100: input.autoCashOutX100 }),
    });
  }

  @Post('rounds/:matchId/cash-out')
  async cashOut(@Param('matchId') matchId: string, @Req() request: AuthenticatedRequest) {
    const result = await this.crash.cashOut(request.auth!.userId, matchId);
    return { matchId, ...result };
  }
}
