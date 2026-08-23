/** Health/readiness contract. Dependency checks are added in P1 when PG/Redis are wired. */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  readonly status: HealthStatus;
  readonly version: string;
  readonly environment: string;
  /** Process uptime in whole seconds. */
  readonly uptimeSeconds: number;
}

export interface ReadinessResponse {
  readonly status: HealthStatus;
  /** Per-dependency results; empty until P1 adds PostgreSQL and Redis. */
  readonly dependencies: ReadonlyArray<{ name: string; status: HealthStatus }>;
}
