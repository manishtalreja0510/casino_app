import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { JOB_QUEUES, QUEUE_CONNECTION } from './jobs.tokens';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(JOB_QUEUES) private readonly queues: Map<string, Queue>,
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
  ) {}

  queue(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`unknown queue "${name}" — declare it in QueueName`);
    return queue;
  }

  /**
   * Registers a worker. Domain modules call this at startup with their own processor;
   * the processor must be idempotent — it re-reads its state machine from PostgreSQL and
   * no-ops if the transition already happened (rule 6).
   */
  registerWorker(name: string, processor: Processor, concurrency = 1): Worker {
    const worker = new Worker(name, processor, { connection: this.connection, concurrency });
    worker.on('failed', (job, error) =>
      this.logger.error(`job ${name}/${job?.id ?? '?'} failed: ${error.message}`),
    );
    this.workers.push(worker);
    return worker;
  }

  async closeWorkers(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
