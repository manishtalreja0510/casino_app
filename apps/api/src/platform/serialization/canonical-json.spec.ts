import { canonicalStringify } from './canonical-json';

describe('canonicalStringify', () => {
  it('is independent of key order — the jsonb round-trip problem', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  it('canonicalises nested objects and objects inside arrays', () => {
    expect(canonicalStringify({ outer: { z: 1, a: [{ y: 1, x: 2 }] } })).toBe(
      canonicalStringify({ outer: { a: [{ x: 2, y: 1 }], z: 1 } }),
    );
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });

  it('still distinguishes genuinely different values', () => {
    expect(canonicalStringify({ pot: 2000 })).not.toBe(canonicalStringify({ pot: 999999 }));
    expect(canonicalStringify({ a: null })).not.toBe(canonicalStringify({ a: 0 }));
  });
});
