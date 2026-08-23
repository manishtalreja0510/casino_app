import { ErrorCode } from '@casino/contracts';
import { DomainError } from '../platform/errors/domain-error';

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(ErrorCode.WALLET_INSUFFICIENT_FUNDS, 'Insufficient funds', 409);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super(ErrorCode.WALLET_CURRENCY_MISMATCH, 'Currency mismatch', 422);
  }
}

export class FundingLimitExceededError extends DomainError {
  constructor(retryAfterHours: number) {
    super(ErrorCode.WALLET_LIMIT_EXCEEDED, 'Funding limit reached for this period', 429, {
      retryAfterHours,
    });
  }
}

/**
 * The funding path is disabled — either its own flag is off, or the compliance gate is on
 * and has force-disabled it (ADR-022). The client is told the operation is unavailable,
 * never which of the two gates closed it.
 */
export class FundingDisabledError extends DomainError {
  constructor() {
    super(ErrorCode.WALLET_OPERATION_DISABLED, 'Adding funds is not available', 403);
  }
}
