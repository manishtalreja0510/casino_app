import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { JOB_QUEUES, QUEUE_CONNECTION } from './jobs.tokens';
import { JobsService } from './jobs.service';
import { QueueName } from './queue-names';

/**
 * BullMQ scaffold (backend-architecture.md §9).
 *
 * Redis provides scheduling and retries; it does not hold state. Financial and game
 * state machines are rows in PostgreSQL — jobs only drive transitions (rule 7).
 *
 * Failed jobs exhaust their backoff and stay in the failed set, which is the dead-letter
 * queue: P12 surfaces it in the admin panel, and reconciliation failures page a human
 * rather than retrying forever (rule 9).
 */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ConnectionOptions => {
        const url = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          host: url.hostname,
          port: Number(url.port || 6379),
          ...(url.password ? { password: url.password } : {}),
        };
      },
    },
    {
      provide: JOB_QUEUES,
      inject: [QUEUE_CONNECTION],
      useFactory: (connection: ConnectionOptions): Map<string, Queue> => {
        const queues = new Map<string, Queue>();
        for (const name of Object.values(QueueName)) {
          queues.set(
            name,
            new Queue(name, {
              connection,
              defaultJobOptions: {
                attempts: 5,
                backoff: { type: 'exponential', delay: 1_000 },
                removeOnComplete: { age: 3_600, count: 1_000 },
                removeOnFail: false,
              },
            }),
          );
        }
        return queues;
      },
    },
    JobsService,
  ],
  exports: [JobsService, QUEUE_CONNECTION],
})
export class JobsModule implements OnApplicationShutdown {
  constructor(
    @Inject(JOB_QUEUES) private readonly queues: Map<string, Queue>,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.jobs.closeWorkers();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
