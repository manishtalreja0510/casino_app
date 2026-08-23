import { z } from 'zod';

/**
 * Request schemas. Validation is contract-driven (zod), not decorator-driven — the same
 * shapes the Dart client is written against (`docs/03-api/api-principles.md`).
 *
 * Password policy is length-first: length dominates entropy, and composition rules push
 * users toward predictable substitutions. 12 characters minimum, no composition rules.
 */
export const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(200),
  displayName: z.string().trim().min(2).max(40),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  deviceId: z.string().uuid().nullish(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(400),
});

export const registerDeviceSchema = z.object({
  /** SPKI public key, base64, without PEM armour. */
  publicKey: z.string().min(40).max(2000),
  label: z.string().trim().max(60).nullish(),
});

export const revokeSessionSchema = z.object({
  sessionId: z.string().uuid().nullish(),
  all: z.boolean().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
