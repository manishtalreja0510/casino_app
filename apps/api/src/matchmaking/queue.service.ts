import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../platform/redis/redis.module';

export interface QueueEntry {
  userId: string;
  tierId: string;
  gameCode: string;
  joinedAt: number;
}

/**
 * Stake-tiered matchmaking queues (`docs/02-domains/matchmaking.md`).
 *
 * Redis, and deliberately disposable (rule 7): losing a queue costs players their place
 * in line and nothing else — no money, no match state. The one operation that must be
 * exactly right is the pop, because two servers popping the same player would seat them
 * in two matches at once and charge them twice.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  /** A queued player who goes quiet is dropped rather than blocking the tier forever. */
  static readonly entryTtlSeconds = 120;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Atomically claims `count` distinct players from a tier.
   *
   * A Lua script, because a read-then-remove from Node leaves a window in which another
   * instance pops the same player. Redis runs the whole script without interleaving, so a
   * player is claimed exactly once — and if fewer than `count` are waiting, nobody is
   * claimed at all rather than half a table being taken hostage.
   *
   * Stale entries (past TTL) are skipped and cleaned up in the same pass.
   */
  private static readonly CLAIM_SCRIPT = `
    local queueKey = KEYS[1]
    local memberPrefix = KEYS[2]
    local needed = tonumber(ARGV[1])
    local cutoff = tonumber(ARGV[2])

    local claimed = {}
    local scanned = 0
    local maxScan = needed * 10 + 50

    while #claimed < needed and scanned < maxScan do
      local userId = redis.call('LPOP', queueKey)
      if not userId then break end
      scanned = scanned + 1

      local raw = redis.call('GET', memberPrefix .. userId)
      if raw then
        local joinedAt = tonumber(raw)
        if joinedAt and joinedAt >= cutoff then
          table.insert(claimed, userId)
        else
          redis.call('DEL', memberPrefix .. userId)
        end
      end
    end

    if #claimed < needed then
      -- Not enough players: put them back at the FRONT, preserving their place in line.
      for i = #claimed, 1, -1 do
        redis.call('LPUSH', queueKey, claimed[i])
      end
      return {}
    end

    for _, userId in ipairs(claimed) do
      redis.call('DEL', memberPrefix .. userId)
    end
    return claimed
  `;

  async join(entry: QueueEntry): Promise<{ queued: boolean; reason?: string }> {
    const memberKey = QueueService.memberKey(entry.tierId, entry.userId);

    // A second device queueing the same player must not create two places in line.
    const alreadyQueued = await this.redis.exists(memberKey);
    if (alreadyQueued) return { queued: false, reason: 'already_queued' };

    await this.redis
      .multi()
      .set(memberKey, String(entry.joinedAt), 'EX', QueueService.entryTtlSeconds)
      .rpush(QueueService.queueKey(entry.tierId), entry.userId)
      .expire(QueueService.queueKey(entry.tierId), QueueService.entryTtlSeconds * 4)
      .exec();

    return { queued: true };
  }

  async leave(tierId: string, userId: string): Promise<boolean> {
    const removed = await this.redis
      .multi()
      .del(QueueService.memberKey(tierId, userId))
      .lrem(QueueService.queueKey(tierId), 0, userId)
      .exec();
    return Boolean(removed?.[0]?.[1]);
  }

  async isQueued(tierId: string, userId: string): Promise<boolean> {
    return (await this.redis.exists(QueueService.memberKey(tierId, userId))) === 1;
  }

  /** Refreshes a waiting player's TTL; the client heartbeats while the queue screen is open. */
  async touch(tierId: string, userId: string): Promise<void> {
    await this.redis.expire(QueueService.memberKey(tierId, userId), QueueService.entryTtlSeconds);
  }

  async claim(tierId: string, count: number): Promise<string[]> {
    const cutoff = Date.now() - QueueService.entryTtlSeconds * 1000;
    const claimed = (await this.redis.eval(
      QueueService.CLAIM_SCRIPT,
      2,
      QueueService.queueKey(tierId),
      QueueService.memberPrefix(tierId),
      String(count),
      String(cutoff),
    )) as string[];
    return claimed ?? [];
  }

  /** Returns players to the queue when a formation fails for a reason that is not theirs. */
  async requeue(tierId: string, userIds: string[]): Promise<void> {
    const now = Date.now();
    const pipeline = this.redis.multi();
    for (const userId of userIds) {
      pipeline.set(QueueService.memberKey(tierId, userId), String(now), 'EX', QueueService.entryTtlSeconds);
      pipeline.lpush(QueueService.queueKey(tierId), userId);
    }
    await pipeline.exec();
  }

  /** Approximate depth — stale entries are only removed when a claim walks past them. */
  async depth(tierId: string): Promise<number> {
    return this.redis.llen(QueueService.queueKey(tierId));
  }

  private static queueKey(tierId: string): string {
    return `mm:q:${tierId}`;
  }

  private static memberPrefix(tierId: string): string {
    return `mm:m:${tierId}:`;
  }

  private static memberKey(tierId: string, userId: string): string {
    return `${QueueService.memberPrefix(tierId)}${userId}`;
  }
}
