import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

export interface TimerHandle {
  id: string;
  deadlineAt: number;
}

/**
 * Server-authoritative deadlines (rule 2).
 *
 * The client is *told* a deadline so it can render a countdown; expiry is decided here.
 * A client with a manipulated clock changes what its player sees and nothing about what
 * the server does.
 *
 * In-process timers are the right tool for turn deadlines specifically: they are seconds
 * long, and if the instance dies the match is being recovered anyway (P6 replays the
 * event log and re-arms). Durable, minutes-to-hours scheduling belongs on BullMQ.
 */
@Injectable()
export class TimerService implements OnApplicationShutdown {
  private readonly logger = new Logger(TimerService.name);
  private readonly timers = new Map<string, { timeout: NodeJS.Timeout; deadlineAt: number }>();

  /** Schedules `onExpire`, replacing any existing timer with the same id. */
  schedule(id: string, delayMs: number, onExpire: () => void | Promise<void>): TimerHandle {
    this.cancel(id);

    const deadlineAt = Date.now() + delayMs;
    const timeout = setTimeout(() => {
      this.timers.delete(id);
      void (async () => {
        try {
          await onExpire();
        } catch (error) {
          // A throwing expiry handler must not take the process down — the match it
          // belongs to is recoverable, an unhandled rejection is not.
          this.logger.error(
            `timer ${id} handler failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      })();
    }, Math.max(0, delayMs));

    // Do not hold the event loop open for a pending game timer during shutdown.
    timeout.unref?.();
    this.timers.set(id, { timeout, deadlineAt });
    return { id, deadlineAt };
  }

  cancel(id: string): boolean {
    const existing = this.timers.get(id);
    if (!existing) return false;
    clearTimeout(existing.timeout);
    this.timers.delete(id);
    return true;
  }

  /** Remaining milliseconds, or null if no such timer. For display payloads. */
  remaining(id: string): number | null {
    const existing = this.timers.get(id);
    return existing ? Math.max(0, existing.deadlineAt - Date.now()) : null;
  }

  get activeCount(): number {
    return this.timers.size;
  }

  onApplicationShutdown(): void {
    for (const { timeout } of this.timers.values()) clearTimeout(timeout);
    this.timers.clear();
  }
}
