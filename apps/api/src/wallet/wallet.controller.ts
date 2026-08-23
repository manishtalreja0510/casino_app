import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { WalletService } from './wallet.service';
import { validate } from '../auth/dto/validate';
import { SignedRequest } from '../auth/guards/signed-request.guard';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';

const fundingSchema = z.object({
  /** Integer minor units (rule 4) — a fractional amount is rejected, never rounded. */
  amount: z.number().int().positive(),
  /** Client-supplied so a retry after a timeout cannot double-credit (rule 6). */
  idempotencyKey: z.string().min(8).max(200),
});

@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('balance')
  async balance(@Req() request: AuthenticatedRequest) {
    const balance = await this.wallet.getBalance(request.auth!.userId);
    return { balance };
  }

  @Get('transactions')
  async transactions(@Req() request: AuthenticatedRequest, @Query('before') before?: string) {
    const items = await this.wallet.listTransactions(request.auth!.userId, {
      ...(before ? { before: new Date(before) } : {}),
    });
    return {
      transactions: items.map((item) => ({
        id: item.id,
        type: item.type,
        amount: { amount: item.amount, currency: item.currency },
        refType: item.refType,
        refId: item.refId,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Interim direct-credit funding (ADR-022).
   *
   * Financial-class: it carries a device signature (P3), is idempotent by client key, and
   * is refused unless its flag is on and the compliance gate is off.
   */
  @Post('funding')
  @SignedRequest()
  async addFunds(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(fundingSchema, body);
    const result = await this.wallet.addFunds({
      userId: request.auth!.userId,
      amount: input.amount,
      idempotencyKey: `funding:${request.auth!.userId}:${input.idempotencyKey}`,
    });
    return {
      transactionId: result.transactionId,
      replayed: result.replayed,
      balance: { amount: result.balance, currency: 'TST' },
    };
  }
}
