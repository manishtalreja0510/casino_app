import { typesFor, windowStart } from './rg.types';

describe('limit windows', () => {
  const at = new Date('2026-08-23T14:37:12.345Z'); // a Sunday

  it('starts a daily window at midnight UTC', () => {
    expect(windowStart('day', at).toISOString()).toBe('2026-08-23T00:00:00.000Z');
  });

  it('starts a weekly window on Monday, not Sunday', () => {
    // 2026-08-23 is a Sunday; its ISO week began on Monday the 17th. Getting this wrong
    // gives a player a fresh weekly allowance every Sunday, which is the day it matters
    // most that they do not get one.
    expect(windowStart('week', at).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('starts a monthly window on the first', () => {
    expect(windowStart('month', at).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('puts a Monday in its own week', () => {
    const monday = new Date('2026-08-17T09:00:00.000Z');
    expect(windowStart('week', monday).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('is stable across a whole window and moves exactly once at its edge', () => {
    const justBefore = new Date('2026-08-23T23:59:59.999Z');
    const justAfter = new Date('2026-08-24T00:00:00.000Z');

    expect(windowStart('day', justBefore).toISOString()).toBe('2026-08-23T00:00:00.000Z');
    expect(windowStart('day', justAfter).toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('does not depend on the machine’s timezone', () => {
    // Every window boundary is UTC. A server in a different zone must meter the same
    // window, or a limit would reset at a different hour depending on where it runs.
    const utcNoon = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
    expect(windowStart('day', utcNoon).getUTCHours()).toBe(0);
    expect(windowStart('day', utcNoon).getUTCMinutes()).toBe(0);
  });
});

describe('which limits a spend counts toward', () => {
  it('meters a wager against both wager and loss limits', () => {
    // A stake is a wager always, and a loss until some of it comes back.
    expect(typesFor('wager')).toEqual(['wager', 'loss']);
  });

  it('meters a deposit against the deposit limit only', () => {
    expect(typesFor('deposit')).toEqual(['deposit']);
  });
});
