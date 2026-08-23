/**
 * Order-independent JSON serialisation.
 *
 * PostgreSQL's `jsonb` does not preserve key order — it normalises keys on storage — so a
 * value written as `{turn, picks, pot}` comes back in a different order. Comparing
 * `JSON.stringify` output across that round trip therefore reports differences that do not
 * exist, which would make every honest match look tampered with.
 *
 * Anything comparing a JS value against one that has been through the database must
 * canonicalise both sides first. (The audit log solves the same problem independently, in
 * `audit.hash.ts`, because its hashes are already committed to and must not change.)
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalise((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}
