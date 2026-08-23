import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { validate } from '../auth/dto/validate';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { RiskService } from './risk.service';

const reportSchema = z.object({
  /**
   * What the device believes about itself.
   *
   * Every one of these is a claim by software an attacker may control, and the server
   * treats them as such: they raise a score and can never, alone, freeze an account. A
   * report that says everything is fine is worth as little as one that says nothing is.
   */
  rootDetected: z.boolean().optional(),
  emulatorDetected: z.boolean().optional(),
  hookDetected: z.boolean().optional(),
  signatureMismatch: z.boolean().optional(),
  integrityFailed: z.boolean().optional(),
  deviceId: z.string().min(1).max(128).optional(),
});

const SIGNAL_FOR: Record<string, string> = {
  rootDetected: 'client.root_detected',
  emulatorDetected: 'client.emulator_detected',
  hookDetected: 'client.hook_detected',
  signatureMismatch: 'client.signature_mismatch',
  integrityFailed: 'client.integrity_failed',
};

/**
 * The client's hardening report, and the player's own view of their standing.
 *
 * The report endpoint exists knowing exactly what it is: a channel for evidence from a
 * process the platform does not trust. It is authenticated so a report can be attributed,
 * and everything it says is weighed by the server's rules rather than the sender's claims
 * (`docs/04-security/mobile-app-hardening.md`).
 */
@Controller('risk')
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Post('client-report')
  async report(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(reportSchema, body);
    const userId = request.auth!.userId;

    for (const [field, type] of Object.entries(SIGNAL_FOR)) {
      if (input[field as keyof typeof input] === true) {
        await this.risk.ingest({
          source: 'client',
          type,
          userId,
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        });
      }
    }

    // Deliberately says nothing about what was concluded. Telling a client which report
    // moved its score hands an attacker a way to binary-search the rules
    // (`fraud-risk.md §6`).
    return { received: true };
  }

  /**
   * What the player may see about their own standing.
   *
   * Only whether something is restricted and where to ask — never the score, the rules, or
   * which signal fired. The first is unhelpful and the rest are an oracle.
   */
  @Get('me')
  async me(@Req() request: AuthenticatedRequest) {
    const gate = await this.risk.gate(request.auth!.userId);
    return {
      restricted: !gate.allowed,
      ...(gate.reason ? { reason: gate.reason } : {}),
    };
  }
}
