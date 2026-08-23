/**
 * Canonical error codes and the single error envelope every REST and WS error uses.
 * See docs/03-api/api-conventions.md and docs/03-api/websocket-conventions.md.
 */

/** Namespaces keep codes greppable and stable across clients that update slowly (rule 23). */
export const ErrorCode = {
  // platform
  INTERNAL: 'INTERNAL',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  MAINTENANCE: 'MAINTENANCE',
  UPDATE_REQUIRED: 'UPDATE_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // auth (docs/02-domains/authentication.md)
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_REFRESH_REUSE_DETECTED: 'AUTH_REFRESH_REUSE_DETECTED',
  AUTH_DEVICE_UNTRUSTED: 'AUTH_DEVICE_UNTRUSTED',
  AUTH_SIGNATURE_INVALID: 'AUTH_SIGNATURE_INVALID',
  AUTH_ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',

  // wallet (docs/02-domains/wallet.md)
  WALLET_INSUFFICIENT_FUNDS: 'WALLET_INSUFFICIENT_FUNDS',
  WALLET_CURRENCY_MISMATCH: 'WALLET_CURRENCY_MISMATCH',
  WALLET_LIMIT_EXCEEDED: 'WALLET_LIMIT_EXCEEDED',
  WALLET_OPERATION_DISABLED: 'WALLET_OPERATION_DISABLED',

  // game (docs/01-architecture/game-architecture.md)
  GAME_NOT_YOUR_TURN: 'GAME_NOT_YOUR_TURN',
  GAME_INVALID_ACTION: 'GAME_INVALID_ACTION',
  GAME_MATCH_NOT_FOUND: 'GAME_MATCH_NOT_FOUND',
  GAME_DISABLED: 'GAME_DISABLED',

  // compliance / responsible gaming
  COMPLIANCE_REAL_MONEY_DISABLED: 'COMPLIANCE_REAL_MONEY_DISABLED',
  RG_SELF_EXCLUDED: 'RG_SELF_EXCLUDED',
  RG_LIMIT_REACHED: 'RG_LIMIT_REACHED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The ONLY error shape crossing the wire. `details` never carries PII or secrets (rule 15). */
export interface ApiErrorBody {
  readonly code: ErrorCodeValue;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Correlation id for support and log lookup — safe to show to users. */
  readonly traceId?: string;
}

export interface ApiErrorEnvelope {
  readonly error: ApiErrorBody;
}

export function apiError(
  code: ErrorCodeValue,
  message: string,
  options: { details?: Record<string, unknown>; traceId?: string } = {},
): ApiErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(options.details ? { details: options.details } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    },
  };
}
