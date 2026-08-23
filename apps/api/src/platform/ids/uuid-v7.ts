import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562) — the project's identifier format everywhere
 * (docs/01-architecture/database-architecture.md §2).
 *
 * v7 puts a millisecond timestamp in the high bits, so ids sort by creation time and
 * primary-key inserts stay append-mostly instead of scattering across the B-tree the way
 * v4 does. That property is why the schema mandates it, and it is what keeps the
 * high-churn append-only tables (ledger entries, game events, audit log) cheap to index.
 *
 * Implemented here rather than taken from a package: the `uuid` package is ESM-only from
 * v14, which a CommonJS Nest build cannot require at runtime.
 *
 * Layout: 48-bit unix_ts_ms | 4-bit version (7) | 12-bit rand_a | 2-bit variant | 62-bit rand_b.
 */

/** Highest millisecond minted so far, and the counter within it. */
let lastTimestamp = -1;
let sequence = 0;

function random12(): number {
  return randomBytes(2).readUInt16BE(0) & 0x0fff;
}

function build(timestampMs: number, seq: number): string {
  const bytes = Buffer.alloc(16);
  // 48-bit big-endian timestamp.
  bytes.writeUIntBE(timestampMs, 0, 6);
  // Version 7 in the high nibble of byte 6; the 12-bit counter fills the rest of rand_a.
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  const rand = randomBytes(8);
  // Variant 0b10 in the two high bits of byte 8.
  bytes[8] = 0x80 | (rand[0]! & 0x3f);
  rand.copy(bytes, 9, 1, 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mints an id from the system clock. **Strictly increasing**, which is the property the
 * rest of the system relies on, guaranteed in two ways:
 *
 *  - A clock that jumps backwards (NTP correction, VM migration) cannot produce an id
 *    that sorts before one already issued: the timestamp is clamped to the highest seen.
 *  - Within a single millisecond the 12-bit counter increments. If more than 4096 ids are
 *    minted in one millisecond the counter borrows the next millisecond rather than wrap.
 */
export function uuidv7(): string {
  const now = Math.max(Date.now(), lastTimestamp);

  if (now === lastTimestamp) {
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) {
      lastTimestamp += 1;
      return build(lastTimestamp, 0);
    }
  } else {
    lastTimestamp = now;
    sequence = random12();
  }

  return build(lastTimestamp, sequence);
}

/**
 * Mints an id encoding exactly the given millisecond, for tests and deterministic
 * backfills. It is deliberately stateless: it does not touch the monotonic counter, and
 * so gives **no ordering guarantee between ids minted for the same millisecond**.
 * Production code uses `uuidv7()`.
 */
export function uuidv7At(timestampMs: number): string {
  return build(timestampMs, random12());
}

/** Milliseconds encoded in a v7 id — useful for debugging and retention queries. */
export function timestampOf(uuid: string): number {
  return parseInt(uuid.replace(/-/g, '').slice(0, 12), 16);
}
