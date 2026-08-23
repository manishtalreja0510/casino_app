import { canonicalise, computeHash, GENESIS_HASH, type HashableAuditRow } from './audit.hash';

const row: HashableAuditRow = {
  id: '018f2b1c-0000-7000-8000-000000000000',
  actorType: 'system',
  actorId: null,
  action: 'wallet.reversal',
  subjectRef: 'tx_123',
  payload: { b: 2, a: 1 },
  createdAt: new Date('2026-08-23T12:00:00.000Z'),
};

describe('audit hash chain', () => {
  it('is deterministic', () => {
    expect(computeHash(GENESIS_HASH, row)).toEqual(computeHash(GENESIS_HASH, row));
  });

  it('is independent of payload key order — hashes must survive a database round trip', () => {
    const reordered = { ...row, payload: { a: 1, b: 2 } };
    expect(computeHash(GENESIS_HASH, reordered)).toEqual(computeHash(GENESIS_HASH, row));
  });

  it('normalises timestamps, so a string from the driver hashes like a Date', () => {
    const asString = { ...row, createdAt: '2026-08-23T12:00:00.000Z' };
    expect(computeHash(GENESIS_HASH, asString)).toEqual(computeHash(GENESIS_HASH, row));
  });

  it('changes when ANY field changes', () => {
    const base = computeHash(GENESIS_HASH, row);
    const variants: HashableAuditRow[] = [
      { ...row, action: 'wallet.credit' },
      { ...row, payload: { a: 1, b: 3 } },
      { ...row, subjectRef: 'tx_124' },
      { ...row, actorType: 'admin' },
      { ...row, createdAt: new Date('2026-08-23T12:00:01.000Z') },
    ];
    for (const variant of variants) {
      expect(computeHash(GENESIS_HASH, variant)).not.toEqual(base);
    }
  });

  it('changes when the previous hash changes — this is what chains the rows', () => {
    const other = Buffer.alloc(32, 1);
    expect(computeHash(other, row)).not.toEqual(computeHash(GENESIS_HASH, row));
  });

  it('canonicalises nested payload objects recursively', () => {
    const a = canonicalise({ ...row, payload: { outer: { z: 1, a: 2 } } });
    const b = canonicalise({ ...row, payload: { outer: { a: 2, z: 1 } } });
    expect(a).toBe(b);
  });
});
