import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;

/**
 * PostgreSQL is the sole source of truth (rule 2, ADR-004). This module owns the pool;
 * modules take `DRIZZLE` (or `PG_POOL` for raw SQL, which the ledger paths in P4 require
 * for explicit row locking — ADR-020).
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          // Kept modest: instance count × pool size must stay well under the server limit.
          // pgbouncer arrives when that ceiling approaches (database-architecture.md §9).
          max: config.get<number>('DATABASE_POOL_MAX') ?? 10,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('postgres pool closed');
  }
}
