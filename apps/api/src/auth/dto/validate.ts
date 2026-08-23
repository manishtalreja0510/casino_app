import type { ZodSchema } from 'zod';
import { ValidationError } from '../../platform/errors/domain-error';

/**
 * Parses a request body against a schema, converting failures into the contract error
 * envelope. Field names and reasons are returned; **values never are**, since a rejected
 * body can contain a password (rule 15).
 */
export function validate<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fields = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    reason: issue.message,
  }));
  throw new ValidationError('Invalid request', { fields });
}
