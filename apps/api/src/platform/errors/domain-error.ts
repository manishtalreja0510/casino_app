import { ErrorCode, type ErrorCodeValue } from '@casino/contracts';

/**
 * Base class for errors that are part of the domain's contract with clients.
 *
 * Anything thrown that is NOT a DomainError is treated as an internal fault and is
 * never described to the client (see AllExceptionsFilter) — that asymmetry is what
 * keeps SQL, stack traces, and driver messages off the wire (rule 15).
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    readonly httpStatus: number = 400,
    /** Safe to send to clients: opaque ids and counts only, never PII or secrets. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found', details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, message, 404, details);
  }
}

export class ValidationError extends DomainError {
  constructor(message = 'Validation failed', details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_FAILED, message, 422, details);
  }
}

export class RateLimitedError extends DomainError {
  constructor(retryAfterSeconds: number) {
    super(ErrorCode.RATE_LIMITED, 'Too many requests', 429, { retryAfterSeconds });
  }
}

export class MaintenanceError extends DomainError {
  constructor(message = 'The platform is temporarily unavailable for maintenance') {
    super(ErrorCode.MAINTENANCE, message, 503);
  }
}

/** Thrown wherever a real-money path is reached while the compliance gate is off (rule 11). */
export class RealMoneyDisabledError extends DomainError {
  constructor() {
    super(
      ErrorCode.COMPLIANCE_REAL_MONEY_DISABLED,
      'Real-money functionality is not enabled',
      403,
    );
  }
}
