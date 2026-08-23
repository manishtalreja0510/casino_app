import { addMoney, assertMinorUnits, money, MoneyError, negateMoney, TEST_CURRENCY } from './money';

describe('money (rule 4: integer minor units only)', () => {
  it('accepts integers', () => {
    expect(money(1500).amount).toBe(1500);
    expect(money(0).currency).toBe(TEST_CURRENCY);
    expect(money(-250).amount).toBe(-250);
  });

  it('rejects floats — the guard that keeps float math out of money', () => {
    expect(() => money(10.5)).toThrow(MoneyError);
    expect(() => money(0.1 + 0.2)).toThrow(MoneyError);
    expect(() => assertMinorUnits(1e-3)).toThrow(MoneyError);
  });

  it('rejects NaN, Infinity and unsafe integers', () => {
    expect(() => money(Number.NaN)).toThrow(MoneyError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('rejects an empty currency', () => {
    expect(() => money(100, '')).toThrow(MoneyError);
  });

  it('adds only within one currency', () => {
    expect(addMoney(money(100), money(250)).amount).toBe(350);
    expect(() => addMoney(money(100, 'TST'), money(100, 'EUR'))).toThrow(MoneyError);
  });

  it('negates for reversal entries', () => {
    expect(negateMoney(money(750)).amount).toBe(-750);
  });

  it('returns frozen values so amounts cannot be mutated in place', () => {
    const m = money(100);
    expect(Object.isFrozen(m)).toBe(true);
  });
});
