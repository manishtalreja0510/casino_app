/**
 * API surface constants shared by every client and the server.
 * See docs/03-api/api-conventions.md.
 */

/** Current REST API version. Changes here are breaking-version changes (rule 23). */
export const API_VERSION = 'v1' as const;

/** Global REST prefix. Admin uses `/admin/v1` (docs/02-domains/admin.md). */
export const API_PREFIX = `/api/${API_VERSION}` as const;

/** Header carrying the idempotency key on mutating requests (docs/03-api/api-conventions.md). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
