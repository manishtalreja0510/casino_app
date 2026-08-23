/**
 * Money is ALWAYS integer minor units plus a currency code (rule 4, ADR-008).
 * Floats and decimals are forbidden everywhere: DB, backend, and client display math.
 */

/** ISO-4217-style code. `TST` is the test currency used until real money is enabled (OQ-08). */
export type CurrencyCode = string;

/** The test currency all development and pre-launch gameplay runs on. */
export const TEST_CURRENCY: CurrencyCode = 'TST';

/** Canonical wire and in-memory representation of an amount of money. */
export interface Money {
  /** Integer minor units (e.g. cents). Never a float. May be negative in ledger entries. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {}

/** Constructs a Money value, rejecting anything that is not a safe integer. */
export function money(amount: number, currency: CurrencyCode = TEST_CURRENCY): Money {
  assertMinorUnits(amount);
  if (!currency || currency.trim().length === 0) {
    throw new MoneyError('currency is required');
  }
  return Object.freeze({ amount, currency });
}

/** Throws unless `amount` is a safe integer — the single guard against float money. */
export function assertMinorUnits(amount: number): void {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`money amount must be an integer in minor units, received ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError('money amount exceeds the safe integer range');
  }
}

/** Adds two amounts of the SAME currency. Cross-currency arithmetic is never implicit. */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function negateMoney(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}
