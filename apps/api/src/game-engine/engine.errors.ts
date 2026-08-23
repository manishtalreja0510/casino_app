import { ErrorCode } from '@casino/contracts';
import { DomainError } from '../platform/errors/domain-error';

export class MatchNotFoundError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_MATCH_NOT_FOUND, 'Match not found', 404);
  }
}

export class NotAParticipantError extends DomainError {
  constructor() {
    // Deliberately the same shape a spectator would get for a match that does not exist
    // would be wrong here — the caller IS authenticated, they are simply not in this match.
    super(ErrorCode.AUTH_FORBIDDEN, 'You are not in this match', 403);
  }
}

export class MatchNotPlayableError extends DomainError {
  constructor(status: string) {
    super(ErrorCode.GAME_INVALID_ACTION, `This match is ${status}`, 409);
  }
}

export class InvalidActionError extends DomainError {
  constructor(message: string) {
    // The reducer's message is game-authored and player-safe; it never carries state.
    super(ErrorCode.GAME_INVALID_ACTION, message, 422);
  }
}

export class GameDisabledError extends DomainError {
  constructor(gameCode: string) {
    super(ErrorCode.GAME_DISABLED, `${gameCode} is currently unavailable`, 503);
  }
}
