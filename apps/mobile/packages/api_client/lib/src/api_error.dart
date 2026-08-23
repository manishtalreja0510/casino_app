/// Error codes mirroring `packages/contracts/src/errors.ts`.
///
/// Unknown codes are preserved as-is rather than collapsed: a client that is a version
/// behind the server (normal for a sideloaded app — rule 23) must still surface a code
/// it does not recognise, not swallow it.
class ApiErrorCode {
  const ApiErrorCode._();

  static const String internal = 'INTERNAL';
  static const String validationFailed = 'VALIDATION_FAILED';
  static const String notFound = 'NOT_FOUND';
  static const String rateLimited = 'RATE_LIMITED';
  static const String maintenance = 'MAINTENANCE';
  static const String updateRequired = 'UPDATE_REQUIRED';
  static const String authTokenExpired = 'AUTH_TOKEN_EXPIRED';
  static const String authTokenInvalid = 'AUTH_TOKEN_INVALID';
  static const String authForbidden = 'AUTH_FORBIDDEN';
  static const String authRefreshReuseDetected = 'AUTH_REFRESH_REUSE_DETECTED';
  static const String authAccountSuspended = 'AUTH_ACCOUNT_SUSPENDED';
  static const String authInvalidCredentials = 'AUTH_INVALID_CREDENTIALS';
  static const String walletInsufficientFunds = 'WALLET_INSUFFICIENT_FUNDS';
  static const String complianceRealMoneyDisabled = 'COMPLIANCE_REAL_MONEY_DISABLED';
  static const String rgSelfExcluded = 'RG_SELF_EXCLUDED';
}

/// A failure from the API, parsed from the `{ error: { code, message, details?, traceId } }`
/// envelope every endpoint uses.
class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.details,
    this.traceId,
    this.statusCode,
  });

  final String code;
  final String message;
  final Map<String, dynamic>? details;

  /// Server-side correlation id. The ONLY internal detail shown to a player — support
  /// uses it to find the full context in the logs (rule 15).
  final String? traceId;

  final int? statusCode;

  /// Parses the contract envelope. A response that is not shaped like the envelope
  /// (a proxy error page, say) becomes a generic internal error rather than leaking
  /// whatever HTML the intermediary returned.
  factory ApiException.fromResponse(int statusCode, dynamic body) {
    if (body is Map<String, dynamic>) {
      final error = body['error'];
      if (error is Map<String, dynamic> && error['code'] is String) {
        return ApiException(
          code: error['code'] as String,
          message: error['message'] is String ? error['message'] as String : 'Request failed',
          details: error['details'] is Map<String, dynamic> ? error['details'] as Map<String, dynamic> : null,
          traceId: error['traceId'] is String ? error['traceId'] as String : null,
          statusCode: statusCode,
        );
      }
    }
    return ApiException(
      code: ApiErrorCode.internal,
      message: 'Request failed',
      statusCode: statusCode,
    );
  }

  /// True when the client must update before it can talk to the server (rule 17).
  bool get requiresUpdate => code == ApiErrorCode.updateRequired;

  bool get isMaintenance => code == ApiErrorCode.maintenance;

  bool get isAuthFailure =>
      code == ApiErrorCode.authTokenExpired || code == ApiErrorCode.authTokenInvalid;

  @override
  String toString() => 'ApiException($code: $message${traceId == null ? '' : ', trace=$traceId'})';
}

/// The request never reached the server, or no answer came back. Distinct from
/// [ApiException] because the UI treats it differently: offline is a condition to retry,
/// not an error the player caused.
class NetworkException implements Exception {
  const NetworkException(this.reason);

  final String reason;

  @override
  String toString() => 'NetworkException($reason)';
}
