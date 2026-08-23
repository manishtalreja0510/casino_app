import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { validate } from '../../auth/dto/validate';
import type { AuthenticatedRequest } from '../../auth/guards/access-token.guard';
import { PokerService } from './poker.service';

const sitSchema = z.object({
  buyIn: z.number().int().min(1),
  seatNo: z.number().int().min(0).max(5).optional(),
});

const actionSchema = z.object({
  type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  /** Total for this street, for a bet or raise. The server validates the bounds. */
  amount: z.number().int().min(0).optional(),
});

const topUpSchema = z.object({ amount: z.number().int().min(1) });
const sitOutSchema = z.object({ sittingOut: z.boolean() });

/**
 * Poker's HTTP surface.
 *
 * Thin, like every other: the player is taken from the access token, never from the body,
 * and no request carries a number the server trusts. An action carries a type and at most
 * an amount; whether it is legal, and what it costs, is decided by the reducer.
 */
@Controller('games/poker')
export class PokerController {
  constructor(private readonly poker: PokerService) {}

  @Get('tables')
  async tables() {
    return { tables: await this.poker.listTables() };
  }

  /** The table as this caller may see it — their own hand if seated, the public one if not. */
  @Get('tables/:tableId')
  async table(@Param('tableId') tableId: string, @Req() request: AuthenticatedRequest) {
    return this.poker.tableView(tableId, request.auth!.userId);
  }

  @Post('tables/:tableId/sit')
  async sit(
    @Param('tableId') tableId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = validate(sitSchema, body);
    return this.poker.sit({
      userId: request.auth!.userId,
      tableId,
      buyIn: input.buyIn,
      ...(input.seatNo === undefined ? {} : { seatNo: input.seatNo }),
    });
  }

  @Post('tables/:tableId/stand')
  async stand(@Param('tableId') tableId: string, @Req() request: AuthenticatedRequest) {
    return this.poker.stand(request.auth!.userId, tableId);
  }

  @Post('tables/:tableId/top-up')
  async topUp(
    @Param('tableId') tableId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = validate(topUpSchema, body);
    return this.poker.topUp(request.auth!.userId, tableId, input.amount);
  }

  @Post('tables/:tableId/sit-out')
  async sitOut(
    @Param('tableId') tableId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = validate(sitOutSchema, body);
    await this.poker.setSittingOut(request.auth!.userId, tableId, input.sittingOut);
    return { sittingOut: input.sittingOut };
  }

  @Post('tables/:tableId/actions')
  async act(
    @Param('tableId') tableId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = validate(actionSchema, body);
    await this.poker.act(request.auth!.userId, tableId, {
      type: input.type,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
    });
    return this.poker.tableView(tableId, request.auth!.userId);
  }
}
