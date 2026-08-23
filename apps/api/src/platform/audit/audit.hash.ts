import { createHash } from 'node:crypto';

/** Genesis link: the chain's first row hashes against 32 zero bytes. */
export const GENESIS_HASH = Buffer.alloc(32, 0);

export interface HashableAuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  subjectRef: string | null;
  payload: unknown;
  createdAt: Date | string;
}

/**
 * Canonical serialisation for hashing.
 *
 * Hashes must be reproducible byte-for-byte when re-read from the database years later,
 * so this cannot depend on JS object key order or on how the driver happens to render a
 * timestamp: keys are written in a fixed order, `payload` is canonicalised recursively
 * with sorted keys, and the timestamp is normalised to an ISO-8601 UTC string.
 */
export function canonicalise(row: HashableAuditRow): string {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();

  return JSON.stringify([
    row.id,
    row.actorType,
    row.actorId ?? null,
    row.action,
    row.subjectRef ?? null,
    canonicaliseValue(row.payload),
    createdAt,
  ]);
}

function canonicaliseValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicaliseValue);
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicaliseValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

/** H(prev_hash || canonical(row)) — tampering with any field breaks every later link. */
export function computeHash(prevHash: Buffer, row: HashableAuditRow): Buffer {
  return createHash('sha256').update(prevHash).update(canonicalise(row), 'utf8').digest();
}
