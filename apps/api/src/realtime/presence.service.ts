import { Inject, Injectable } from '@nestjs/common';
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
  static readonly ttlSeconds = 60;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async join(room: string, userId: string, socketId: string): Promise<void> {
    await this.redis
      .multi()
      .hset(PresenceService.key(room), socketId, userId)
      .expire(PresenceService.key(room), PresenceService.ttlSeconds)
      .exec();
  }

  async leave(room: string, socketId: string): Promise<void> {
    await this.redis.hdel(PresenceService.key(room), socketId);
  }

  /** Distinct user ids present — a user with two devices counts once. */
  async members(room: string): Promise<string[]> {
    const entries = await this.redis.hgetall(PresenceService.key(room));
    return [...new Set(Object.values(entries))];
  }

  /** Refreshes the TTL for a live connection; called on heartbeat. */
  async touch(room: string): Promise<void> {
    await this.redis.expire(PresenceService.key(room), PresenceService.ttlSeconds);
  }

  private static key(room: string): string {
    return `rt:presence:${room}`;
  }
}
