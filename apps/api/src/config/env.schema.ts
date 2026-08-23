import { z } from 'zod';

/**
 * Environment contract for the API.
 *
 * The application FAILS FAST on invalid config rather than falling back to defaults:
 * an environment that is misconfigured must not quietly run as if it were `dev`
 * (see docs/phases/PHASE-00-foundations.md §15).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Deployment environment. Mirrors the Flutter flavors (ADR-012). */
  APP_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** PostgreSQL — the sole source of truth (rule 2). Required everywhere since P1. */
  DATABASE_URL: z.string().url(),
  /** Redis — cache, queues, rate limiting. Never financial truth (rule 7). */
  REDIS_URL: z.string().url(),

  /**
   * ES256 key pair for access tokens (ADR-013). PEM, supplied by the secret manager in
   * staging/prod and by the local .env in dev — never committed (rule 14).
   */
  JWT_PRIVATE_KEY: z.string().min(100),
  JWT_PUBLIC_KEY: z.string().min(80),
  JWT_KEY_ID: z.string().default('dev-1'),

  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigValidationError extends Error {}

/** Validates raw `process.env`. Throws with a readable, secret-free message. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Only field names and reasons are surfaced — never the offending values,
    // which may contain credentials (rule 15).
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigValidationError(`Invalid environment configuration — ${problems}`);
  }

  return result.data;
}
