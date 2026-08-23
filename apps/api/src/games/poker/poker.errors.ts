import { ErrorCode } from '@casino/contracts';
import { DomainError } from '../../platform/errors/domain-error';

export class TableUnavailableError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_DISABLED, 'That table is not available', 404);
  }
}

export class TableFullError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_INVALID_ACTION, 'That table is full', 409);
  }
}

export class AlreadySeatedError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_INVALID_ACTION, 'You are already sitting at this table', 409);
  }
}

export class NotSeatedError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_INVALID_ACTION, 'You are not sitting at this table', 409);
  }
}

export class BuyInOutOfBoundsError extends DomainError {
  constructor(min: number, max: number) {
    super(ErrorCode.GAME_INVALID_ACTION, `The buy-in at this table is between ${min} and ${max}`, 400);
  }
}

export class TooManyTablesError extends DomainError {
  constructor(limit: number) {
    super(ErrorCode.GAME_INVALID_ACTION, `You can play at most ${limit} tables at once`, 409);
  }
}

export class MidHandError extends DomainError {
  constructor(what: string) {
    super(ErrorCode.GAME_INVALID_ACTION, `${what} takes effect when the hand finishes`, 409);
  }
}
