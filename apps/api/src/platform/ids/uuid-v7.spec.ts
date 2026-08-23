import { timestampOf, uuidv7, uuidv7At } from './uuid-v7';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  afterEach(() => jest.restoreAllMocks());

  it('produces a well-formed v7 uuid with the correct variant bits', () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(UUID_RE);
    }
  });

  it('is unique across many rapid calls', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });

  it('sorts in creation order — the property the schema relies on', () => {
    const ids = Array.from({ length: 5_000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays strictly increasing when the clock is frozen, past counter exhaustion', () => {
    // A frozen clock is the worst case for intra-millisecond ordering: 10k ids in one
    // millisecond forces the 12-bit counter (4096) to overflow more than once.
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('never sorts backwards when the system clock jumps back', () => {
    const start = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    const before = uuidv7();

    // Clock corrected backwards by a minute.
    jest.spyOn(Date, 'now').mockReturnValue(start - 60_000);
    const after = uuidv7();

    expect(after > before).toBe(true);
  });
});

describe('uuidv7At', () => {
  it('encodes exactly the timestamp given, so it can be read back', () => {
    for (const ts of [1_000_000_000_000, 1_700_000_000_000, 1_900_000_000_000]) {
      expect(timestampOf(uuidv7At(ts))).toBe(ts);
    }
  });

  it('orders across different milliseconds', () => {
    const early = uuidv7At(1_000_000_000_000);
    const later = uuidv7At(1_700_000_000_000);
    const latest = uuidv7At(1_900_000_000_000);
    expect([latest, early, later].sort()).toEqual([early, later, latest]);
  });

  it('is stateless — it does not disturb the monotonic clock path', () => {
    const before = uuidv7();
    uuidv7At(1_000_000_000_000); // far in the past
    expect(uuidv7() > before).toBe(true);
  });
});
