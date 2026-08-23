import 'package:api_client/api_client.dart';
import 'package:flutter/foundation.dart';

/// Authentication state.
///
/// `unknown` exists so the UI can distinguish "still restoring a saved session" from
/// "definitely signed out" — without it, every cold start flashes the login screen.
enum AuthStatus { unknown, authenticated, unauthenticated }

@immutable
class AuthState {
  const AuthState({required this.status, this.user, this.failure});

  const AuthState.unknown() : status = AuthStatus.unknown, user = null, failure = null;
  const AuthState.signedOut({this.failure})
    : status = AuthStatus.unauthenticated,
      user = null;
  const AuthState.signedIn(AuthUser this.user)
    : status = AuthStatus.authenticated,
      failure = null;

  final AuthStatus status;
  final AuthUser? user;

  /// Message to surface after an involuntary sign-out (session revoked, token reuse).
  final String? failure;

  bool get isAuthenticated => status == AuthStatus.authenticated;
  bool get isResolved => status != AuthStatus.unknown;
}
