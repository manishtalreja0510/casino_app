import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../platform/redis/redis.module';
import type { SocketIdentity } from './realtime.types';

/**
 * One-time WebSocket tickets (`docs/02-domains/authentication.md`).
 *
 * The access token is not sent over the socket handshake: handshake parameters end up in
 * proxy logs and browser histories far more readily than an Authorization header, and a
 * long-lived credential should not be exposed to that. A ticket is instead short-lived,
 * single-use, and bound to the session that requested it.
 *
 * Consumption is atomic (`GETDEL`), so two connections racing on the same ticket cannot
 * both succeed — the loser is refused rather than silently sharing an identity.
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  static readonly ttlSeconds = 30;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async issue(identity: SocketIdentity): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.set(
      TicketService.key(ticket),
      JSON.stringify(identity),
      'EX',
      TicketService.ttlSeconds,
    );
    return { ticket, expiresInSeconds: TicketService.ttlSeconds };
  }

  /** Consumes a ticket. Returns null if unknown, expired, or already used. */
  async consume(ticket: string): Promise<SocketIdentity | null> {
    if (!ticket || ticket.length > 200) return null;
    try {
      const raw = await this.redis.getdel(TicketService.key(ticket));
      return raw ? (JSON.parse(raw) as SocketIdentity) : null;
    } catch (error) {
      // Ticket store unavailable: refuse the connection. Real-time play is not worth
      // admitting unauthenticated sockets (rule 1).
      this.logger.error(
        `ticket store unavailable (${error instanceof Error ? error.message : 'unknown'}); refusing connection`,
      );
      return null;
    }
  }

  private static key(ticket: string): string {
    return `rt:ticket:${ticket}`;
  }
}
