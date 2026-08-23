import { ErrorCode, type ErrorCodeValue } from '@casino/contracts';
import { DomainError } from '../platform/errors/domain-error';

/**
 * A refusal a player is entitled to understand.
 *
 * Every one of these carries its reason, because an RG block the player cannot make sense
 * of turns a safety feature into a support ticket — and, worse, into a reason to look for
 * somewhere that will not explain either.
 *
 * The code is distinct per cause so the client can respond appropriately: an exclusion is
 * permanent-ish and sends the player to their RG page, a limit resets tomorrow, and a
 * pending reality check just needs a tap.
 */
export class RgBlockedError extends DomainError {
  constructor(reason: string, code: ErrorCodeValue = ErrorCode.RG_LIMIT_REACHED) {
    super(code, reason, 403);
  }

  static excluded(reason: string): RgBlockedError {
    return new RgBlockedError(reason, ErrorCode.RG_SELF_EXCLUDED);
  }

  static realityCheck(reason: string): RgBlockedError {
    return new RgBlockedError(reason, ErrorCode.RG_CHECK_PENDING);
  }
}

export class RgInvalidLimitError extends DomainError {
  constructor(reason: string) {
    super(ErrorCode.VALIDATION_FAILED, reason, 400);
  }
}
