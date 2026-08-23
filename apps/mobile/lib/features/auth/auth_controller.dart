import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import 'auth_state.dart';
import 'token_store.dart';

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore.standard());

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>((ref) {
  final controller = AuthController(
    client: ref.watch(apiClientProvider),
    store: ref.watch(tokenStoreProvider),
  );
  unawaited(controller.restore());
  return controller;
});

void unawaited(Future<void> future) {}

/// Owns the authenticated session.
///
/// The client holds tokens and forwards them; it decides nothing about whether they are
/// valid — the server does, on every request (rule 1). When the server says a session is
/// gone, the only correct response is to drop local state and show why.
class AuthController extends StateNotifier<AuthState> {
  AuthController({required CasinoApiClient client, required TokenStore store})
    : _client = client,
      _store = store,
      super(const AuthState.unknown()) {
    _client.accessTokenProvider = _store.readAccessToken;
  }

  final CasinoApiClient _client;
  final TokenStore _store;

  /// Restores a saved session at startup, refreshing if the access token has expired.
  Future<void> restore() async {
    final refreshToken = await _store.readRefreshToken();
    if (refreshToken == null) {
      state = const AuthState.signedOut();
      return;
    }

    try {
      state = AuthState.signedIn(await _client.me());
      return;
    } on ApiException catch (error) {
      if (!error.isAuthFailure) {
        // Maintenance, rate limiting, or an unreachable backend is not a signed-out state:
        // dropping the session here would sign the player out over a transient outage.
        state = const AuthState.unknown();
        return;
      }
    } on NetworkException {
      state = const AuthState.unknown();
      return;
    }

    await _refreshOrSignOut(refreshToken);
  }

  Future<void> _refreshOrSignOut(String refreshToken) async {
    try {
      final tokens = await _client.refresh(refreshToken);
      await _store.save(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken);
      state = AuthState.signedIn(await _client.me());
    } on ApiException catch (error) {
      await _store.clear();
      state = AuthState.signedOut(
        failure: error.code == ApiErrorCode.authRefreshReuseDetected
            ? 'Your session was ended for security reasons. Please sign in again.'
            : null,
      );
    } on NetworkException {
      state = const AuthState.unknown();
    }
  }

  Future<String?> register({
    required String email,
    required String password,
    required String displayName,
  }) async {
    return _attempt(() => _client.register(email: email, password: password, displayName: displayName));
  }

  Future<String?> login({required String email, required String password}) async {
    return _attempt(() => _client.login(email: email, password: password));
  }

  /// Returns null on success, or a user-facing message on failure.
  Future<String?> _attempt(
    Future<({AuthTokens tokens, AuthUser user})> Function() action,
  ) async {
    try {
      final result = await action();
      await _store.save(
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
      );
      state = AuthState.signedIn(result.user);
      return null;
    } on ApiException catch (error) {
      // The server's message is already user-safe by construction (rule 15).
      return error.message;
    } on NetworkException {
      return 'Cannot reach the server. Check your connection and try again.';
    }
  }

  Future<void> logout() async {
    try {
      await _client.logout();
    } on ApiException {
      // Already invalid server-side; clearing locally is still correct.
    } on NetworkException {
      // Offline: drop local tokens anyway. The session remains until the device
      // reconnects, which is why "sign out everywhere" exists server-side.
    }
    await _store.clear();
    state = const AuthState.signedOut();
  }
}
