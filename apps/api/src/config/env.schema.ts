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

  /**
   * Wired in P1. Declared here so the local stack is discoverable and so a
   * missing value in staging/prod is caught at boot rather than at first query.
   */
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
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

  const env = result.data;
  if (env.APP_ENV !== 'dev' && (!env.DATABASE_URL || !env.REDIS_URL)) {
    throw new ConfigValidationError(
      `Invalid environment configuration — DATABASE_URL and REDIS_URL are required when APP_ENV is "${env.APP_ENV}"`,
    );
  }
  return env;
}
