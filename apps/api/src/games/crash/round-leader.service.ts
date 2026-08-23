import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../platform/redis/redis.module';
import { uuidv7 } from '../../platform/ids/uuid-v7';

/**
 * A short lease naming one instance as the driver of a tier's round loop.
 *
 * Rounds are the one part of the platform that happens without anybody asking for it, so
 * unlike every request-driven path it needs an answer to "which instance does this?".
 * Without a lease, two API instances would each open a round for the same tier every few
 * seconds: two betting windows, two escrows, two crash points, and players split between
 * them with no way to tell which round their bet landed in.
 *
 * This is a lease, not a lock, and the difference matters: it is *not* what keeps money
 * correct. Every money movement is still a PostgreSQL transaction with its own row locks
 * and idempotency key, so the worst a lost or double-granted lease can do is open a round
 * nobody wanted or delay the next one (rule 7 — Redis holds no financial truth). Losing
 * the lease mid-round is safe too: a round already in flight is driven by the engine's own
 * timer and its state lives in PostgreSQL, so it finishes wherever it started.
 */
@Injectable()
export class RoundLeaderService implements OnApplicationShutdown {
  private readonly logger = new Logger(RoundLeaderService.name);

  /** Long enough to survive a GC pause or a slow round tick, short enough to fail over. */
  static readonly leaseMs = 15_000;

  /** This process's identity for the lease. Unique per boot, deliberately not the host. */
  private readonly instanceId = uuidv7();
  private readonly held = new Set<string>();
  private renewTimer?: NodeJS.Timeout;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Tries to take or extend the lease for `scope`.
   *
   * Returns false — not throws — when Redis is unreachable. A cache outage should stop
   * new rounds opening (better than every instance opening its own), not take the API
   * down with it.
   */
  async acquire(scope: string): Promise<boolean> {
    const key = RoundLeaderService.key(scope);
    try {
      if (this.held.has(scope)) {
        // Extend only if we still own it: a lease that expired and was taken by somebody
        // else must not be silently stolen back.
        const owner = await this.redis.get(key);
        if (owner !== this.instanceId) {
          this.held.delete(scope);
          return false;
        }
        await this.redis.pexpire(key, RoundLeaderService.leaseMs);
        return true;
      }

      const result = await this.redis.set(key, this.instanceId, 'PX', RoundLeaderService.leaseMs, 'NX');
      if (result !== 'OK') return false;

      this.held.add(scope);
      this.startRenewing();
      return true;
    } catch (error) {
      this.logger.warn(
        `could not reach redis for the ${scope} round lease: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      this.held.delete(scope);
      return false;
    }
  }

  /** Gives up a lease immediately, so another instance can take over without waiting. */
  async release(scope: string): Promise<void> {
    if (!this.held.delete(scope)) return;
    try {
      // Only delete our own lease. Deleting unconditionally would hand the next holder's
      // lease away the moment ours had already expired.
      const owner = await this.redis.get(RoundLeaderService.key(scope));
      if (owner === this.instanceId) await this.redis.del(RoundLeaderService.key(scope));
    } catch {
      // It expires on its own; nothing to do.
    }
  }

  private startRenewing(): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => {
      void (async () => {
        for (const scope of [...this.held]) {
          try {
            const key = RoundLeaderService.key(scope);
            const owner = await this.redis.get(key);
            if (owner === this.instanceId) {
              await this.redis.pexpire(key, RoundLeaderService.leaseMs);
            } else {
              this.held.delete(scope);
            }
          } catch {
            this.held.delete(scope);
          }
        }
      })();
    }, RoundLeaderService.leaseMs / 3);
    this.renewTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    for (const scope of [...this.held]) await this.release(scope);
  }

  private static key(scope: string): string {
    return `round:leader:${scope}`;
  }
}
