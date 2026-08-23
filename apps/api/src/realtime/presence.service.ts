import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../platform/redis/redis.module';

/**
 * Room membership across instances.
 *
 * Kept in Redis so any instance can answer "who is in this match", and expiring so a
 * hard-killed instance does not leave ghosts behind forever. Presence is a hint for UI
 * and matchmaking — never an authority on whether someone is entitled to be in a room
 * (that is checked at join) or on match state (that is the engine's).
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  static readonly ttlSeconds = 60;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async join(room: string, userId: string, socketId: string): Promise<void> {
    await this.tolerate('join', () =>
      this.redis
        .multi()
        .hset(PresenceService.key(room), socketId, userId)
        .expire(PresenceService.key(room), PresenceService.ttlSeconds)
        .exec(),
    );
  }

  async leave(room: string, socketId: string): Promise<void> {
    await this.tolerate('leave', () => this.redis.hdel(PresenceService.key(room), socketId));
  }

  /** Distinct user ids present — a user with two devices counts once. */
  async members(room: string): Promise<string[]> {
    const entries = await this.tolerate('members', () =>
      this.redis.hgetall(PresenceService.key(room)),
    );
    return entries ? [...new Set(Object.values(entries))] : [];
  }

  /**
   * Every user with at least one live connection.
   *
   * Scans the per-user presence keys rather than keeping a set, because a set would need
   * removing on disconnect and a hard-killed instance never gets to do that — the TTL on
   * each key is what keeps this honest. Bounded by the number of connected players, and
   * read by the responsible-gaming sweeps rather than by anything on a request path.
   */
  async connectedUsers(): Promise<string[]> {
    const prefix = PresenceService.key('user:');
    const users = new Set<string>();

    const scanned = await this.tolerate('scan', async () => {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        found.push(...keys);
      } while (cursor !== '0');
      return found;
    });

    for (const key of scanned ?? []) {
      const entries = await this.tolerate('members', () => this.redis.hgetall(key));
      for (const userId of Object.values(entries ?? {})) users.add(userId);
    }
    return [...users];
  }

  /** Refreshes the TTL for a live connection; called on heartbeat. */
  async touch(room: string): Promise<void> {
    await this.tolerate('touch', () =>
      this.redis.expire(PresenceService.key(room), PresenceService.ttlSeconds),
    );
  }

  /**
   * Runs a presence write, tolerating a Redis that will not take it.
   *
   * Presence is a hint (see the class comment) — losing an entry costs a stale roster row
   * until its TTL expires, and nothing else. Every consumer must tolerate Redis being
   * unavailable (rule 7), and this one had not been: with the offline queue deliberately
   * off, a command issued while the client is down throws, and `leave` is called from the
   * gateway's disconnect handler — which runs *during shutdown*, after the client has been
   * closed. The result was an unhandled rejection escaping app teardown and failing
   * whichever test suite happened to be running next.
   *
   * Returns `null` when the operation could not be performed, so a caller that needs an
   * answer can tell "empty" from "unknown".
   */
  private async tolerate<T>(operation: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      this.logger.warn(
        `presence ${operation} unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  private static key(room: string): string {
    return `rt:presence:${room}`;
  }
}
