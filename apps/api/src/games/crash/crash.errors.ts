import { ErrorCode } from '@casino/contracts';
import { DomainError } from '../../platform/errors/domain-error';

export class NoOpenRoundError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_INVALID_ACTION, 'Betting is closed for this round', 409);
  }
}

export class BetOutOfBoundsError extends DomainError {
  constructor(min: number, max: number) {
    super(ErrorCode.GAME_INVALID_ACTION, `Bets in this tier are between ${min} and ${max}`, 400);
  }
}

export class RoundLimitReachedError extends DomainError {
  constructor(detail: string) {
    super(ErrorCode.GAME_INVALID_ACTION, `This round cannot take that bet: ${detail}`, 409);
  }
}

export class CrashTierUnavailableError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_DISABLED, 'That Crash table is not available', 404);
  }
}

export class InvalidAutoCashOutError extends DomainError {
  constructor(max: number) {
    super(
      ErrorCode.GAME_INVALID_ACTION,
      `Auto cash-out must be between 1.01x and ${(max / 100).toFixed(2)}x`,
      400,
    );
  }
}
