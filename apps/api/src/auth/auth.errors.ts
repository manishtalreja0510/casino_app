import { ErrorCode } from '@casino/contracts';
import { DomainError } from '../platform/errors/domain-error';

/**
 * Login failures are deliberately indistinguishable to the client: "wrong password" and
 * "no such account" return the same code and message, so the endpoint cannot be used to
 * enumerate registered emails.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid email or password', 401);
  }
}

export class EmailAlreadyRegisteredError extends DomainError {
  constructor() {
    super(ErrorCode.VALIDATION_FAILED, 'That email address cannot be used', 409);
  }
}

export class TokenInvalidError extends DomainError {
  constructor(message = 'Invalid or expired token') {
    super(ErrorCode.AUTH_TOKEN_INVALID, message, 401);
  }
}

export class TokenExpiredError extends DomainError {
  constructor() {
    super(ErrorCode.AUTH_TOKEN_EXPIRED, 'Session expired, please sign in again', 401);
  }
}

/** Raised when a used refresh token is presented — the signal of a stolen token chain. */
export class RefreshReuseDetectedError extends DomainError {
  constructor() {
    super(
      ErrorCode.AUTH_REFRESH_REUSE_DETECTED,
      'Your session was ended for security reasons. Please sign in again.',
      401,
    );
  }
}

export class AccountUnavailableError extends DomainError {
  constructor(status: string) {
    super(
      status === 'self_excluded' ? ErrorCode.RG_SELF_EXCLUDED : ErrorCode.AUTH_ACCOUNT_SUSPENDED,
      status === 'self_excluded'
        ? 'This account is self-excluded'
        : 'This account is not available. Contact support.',
      403,
    );
  }
}

export class SignatureInvalidError extends DomainError {
  constructor(reason: string) {
    // The reason is a fixed vocabulary (clock_skew, replayed_nonce, …), never internal detail.
    super(ErrorCode.AUTH_SIGNATURE_INVALID, 'Request signature rejected', 401, { reason });
  }
}

export class DeviceUntrustedError extends DomainError {
  constructor() {
    super(ErrorCode.AUTH_DEVICE_UNTRUSTED, 'Device is not registered for this account', 401);
  }
}
