import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsService } from '../platform/jobs/jobs.service';
import { QueueName } from '../platform/jobs/queue-names';
import { MatchmakingService } from './matchmaking.service';

/** How often the queues are re-checked for a formation that never happened. */
const SWEEP_INTERVAL_MS = 10_000;

/**
 * The formation sweep, on a schedule (P7 debt, paid in P8).
 *
 * `joinQueue` already tries to form a match the moment a player arrives, which handles the
 * ordinary case. It does not handle the case that actually strands people: a formation
 * that fails — someone became busy, someone could not pay — puts the survivors back in the
 * queue, and nothing else arrives to try again. Until this job existed, those players
 * waited until an unrelated stranger happened to join the same tier.
 *
 * BullMQ rather than a bare `setInterval`, so that with several instances running the
 * sweep happens on one of them rather than on all of them, and so a sweep that throws is
 * visible in the failed set instead of vanishing.
 */
@Injectable()
export class FormationSweeper implements OnApplicationBootstrap {
  private readonly logger = new Logger(FormationSweeper.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly matchmaking: MatchmakingService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Scheduled work is an instance role (ADR-023). An instance that has not taken it on
    // still forms matches when players join — it just does not sweep on a timer.
    if (!this.config.get<boolean>('SCHEDULED_WORK_ENABLED', true)) {
      this.logger.log('formation sweep disabled for this instance (SCHEDULED_WORK_ENABLED=false)');
      return;
    }

    try {
      this.jobs.registerWorker(QueueName.MATCHMAKING, async (job) => {
        if (job.name !== 'sweep') return;
        const formed = await this.matchmaking.sweep();
        if (formed > 0) this.logger.log(`sweep formed ${formed} match(es)`);
      });

      // A named scheduler rather than a repeating job: upserting it is idempotent, so
      // every instance booting re-declares the same schedule instead of each adding its
      // own timer.
      await this.jobs
        .queue(QueueName.MATCHMAKING)
        .upsertJobScheduler(
          'matchmaking-sweep',
          { every: SWEEP_INTERVAL_MS },
          { name: 'sweep', opts: { removeOnComplete: true, attempts: 1 } },
        );
    } catch (error) {
      // Redis being unavailable must not stop the API from serving: without the sweep,
      // matches still form when players join, which is the common path (rule 7).
      this.logger.warn(
        `formation sweeper not scheduled: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
