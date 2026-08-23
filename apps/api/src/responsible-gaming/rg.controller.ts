import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { validate } from '../auth/dto/validate';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { RgService } from './rg.service';
import { REALITY_CHECK_MAX_MS, REALITY_CHECK_MIN_MS } from './rg.types';

const limitSchema = z.object({
  type: z.enum(['deposit', 'loss', 'wager', 'session_time']),
  period: z.enum(['day', 'week', 'month']),
  amount: z.number().int().min(0),
});

const cancelSchema = z.object({
  type: z.enum(['deposit', 'loss', 'wager', 'session_time']),
  period: z.enum(['day', 'week', 'month']),
});

const excludeSchema = z.object({
  kind: z.enum(['cool_off', 'self_exclusion']),
  /** Null means permanent, which is only valid for a self-exclusion. */
  durationMs: z.number().int().min(1).nullable(),
  /**
   * Typed confirmation for anything irreversible.
   *
   * Client-side friction is UX, not a control — but the server asks for it too, so a
   * permanent exclusion cannot be triggered by a mis-tap, a replayed request, or a script
   * that found the endpoint.
   */
  confirm: z.literal('I understand'),
});

const intervalSchema = z.object({
  intervalMs: z.number().int().min(REALITY_CHECK_MIN_MS).max(REALITY_CHECK_MAX_MS),
});

/**
 * The player's own responsible-gaming controls.
 *
 * Everything here acts on the caller — there is no user id in any payload, so there is no
 * shape of request that sets someone else's limits or excludes someone else's account.
 */
@Controller('rg')
export class RgController {
  constructor(private readonly rg: RgService) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest) {
    return this.rg.statusFor(request.auth!.userId);
  }

  @Post('limits')
  async setLimit(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(limitSchema, body);
    const result = await this.rg.setLimit({ userId: request.auth!.userId, ...input });
    return { effective: result.effective, effectiveAt: result.effectiveAt?.toISOString() ?? null };
  }

  @Post('limits/cancel-pending')
  async cancelPending(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(cancelSchema, body);
    await this.rg.cancelPendingIncrease(request.auth!.userId, input.type, input.period);
    return { cancelled: true };
  }

  @Post('exclusions')
  async exclude(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(excludeSchema, body);
    const result = await this.rg.exclude({
      userId: request.auth!.userId,
      kind: input.kind,
      durationMs: input.durationMs,
      source: 'player',
    });
    return { endsAt: result.endsAt?.toISOString() ?? null };
  }

  @Post('reality-check/interval')
  async setInterval(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(intervalSchema, body);
    await this.rg.setRealityCheckInterval(request.auth!.userId, input.intervalMs);
    return { intervalMs: input.intervalMs };
  }

  @Post('reality-check/acknowledge')
  async acknowledge(@Req() request: AuthenticatedRequest) {
    await this.rg.acknowledgeRealityCheck(request.auth!.userId);
    return { acknowledged: true };
  }
}
