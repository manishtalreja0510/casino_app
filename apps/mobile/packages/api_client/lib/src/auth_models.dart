/// Auth payloads mirroring the API's `/auth/*` surface (P3).
library;

class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.displayName,
    required this.status,
    required this.kycLevel,
  });

  final String id;
  final String email;
  final String displayName;

  /// active | suspended | self_excluded | closed.
  final String status;

  /// L0 today for everyone — verification is deferred (OQ-03).
  final String kycLevel;

  bool get isActive => status == 'active';

  factory AuthUser.fromJson(Map<String, dynamic> json) => AuthUser(
    id: json['id'] as String,
    email: json['email'] as String? ?? '',
    displayName: json['displayName'] as String? ?? '',
    status: json['status'] as String? ?? 'active',
    kycLevel: json['kycLevel'] as String? ?? 'L0',
  );
}

/// Tokens from register/login/refresh.
///
/// The refresh token is single-use: the server rotates it on every use and treats a
/// replay as theft, so the client must persist the newest one immediately and never
/// retry a refresh with a token it has already sent.
class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresInSeconds,
  });

  final String accessToken;
  final String refreshToken;
  final int expiresInSeconds;

  factory AuthTokens.fromJson(Map<String, dynamic> json) => AuthTokens(
    accessToken: json['accessToken'] as String,
    refreshToken: json['refreshToken'] as String,
    expiresInSeconds: json['expiresInSeconds'] as int? ?? 600,
  );
}

class AuthSession {
  const AuthSession({
    required this.id,
    required this.current,
    required this.country,
    required this.createdAt,
    required this.lastSeenAt,
  });

  final String id;
  final bool current;
  final String? country;
  final DateTime createdAt;
  final DateTime lastSeenAt;

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
    id: json['id'] as String,
    current: json['current'] as bool? ?? false,
    country: json['country'] as String?,
    createdAt: DateTime.parse(json['createdAt'] as String),
    lastSeenAt: DateTime.parse(json['lastSeenAt'] as String),
  );
}
