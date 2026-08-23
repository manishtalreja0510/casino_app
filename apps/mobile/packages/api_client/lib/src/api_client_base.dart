import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_error.dart';
import 'auth_models.dart';
import 'crash_models.dart';
import 'health.dart';
import 'lobby_models.dart';
import 'money.dart';
import 'wallet_models.dart';

/// REST client for the casino_app API.
///
/// Responsibilities are deliberately narrow: send a request, parse the contract envelope,
/// raise a typed failure. It holds no business logic and computes nothing about money or
/// game state — the server is authoritative (rules 1, 21).
class CasinoApiClient {
  CasinoApiClient({
    required this.baseUrl,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 15),
  }) : _http = httpClient ?? http.Client();

  /// Includes the version prefix, e.g. `https://api.example.com/api/v1`.
  final String baseUrl;
  final Duration timeout;
  final http.Client _http;

  /// Set once auth exists (P3). Kept as a callback rather than a stored token so the
  /// client never owns credential lifetime — refresh and rotation live in the auth layer.
  Future<String?> Function()? accessTokenProvider;

  Future<HealthResponse> health() async {
    final json = await _get('/health');
    return HealthResponse.fromJson(json);
  }

  Future<ReadinessResponse> readiness() async {
    final json = await _get('/health/ready');
    return ReadinessResponse.fromJson(json);
  }

  // ---- auth (P3) ----

  Future<({AuthTokens tokens, AuthUser user})> register({
    required String email,
    required String password,
    required String displayName,
  }) async {
    final json = await _post('/auth/register', {
      'email': email,
      'password': password,
      'displayName': displayName,
    });
    return (
      tokens: AuthTokens.fromJson(json),
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  Future<({AuthTokens tokens, AuthUser user})> login({
    required String email,
    required String password,
    String? deviceId,
  }) async {
    final json = await _post('/auth/login', {
      'email': email,
      'password': password,
      if (deviceId != null) 'deviceId': deviceId,
    });
    return (
      tokens: AuthTokens.fromJson(json),
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  /// Rotates the refresh token. The returned token replaces the old one, which the
  /// server has now consumed — reusing it is treated as theft and ends every session.
  Future<AuthTokens> refresh(String refreshToken) async {
    final json = await _post('/auth/refresh', {'refreshToken': refreshToken});
    return AuthTokens.fromJson(json);
  }

  Future<void> logout() async => _post('/auth/logout', const {});

  Future<AuthUser> me() async => AuthUser.fromJson(await _get('/auth/me'));

  Future<List<AuthSession>> sessions() async {
    final json = await _get('/auth/sessions');
    return (json['sessions'] as List<dynamic>)
        .whereType<Map<String, dynamic>>()
        .map(AuthSession.fromJson)
        .toList();
  }

  Future<void> revokeAllSessions() async => _post('/auth/sessions/revoke', {'all': true});

  // ---- wallet (P4) ----

  // ---- lobby & matchmaking (P7) ----

  Future<List<LobbyGame>> lobby() async {
    final json = await _get('/lobby');
    return (json['games'] as List<dynamic>)
        .whereType<Map<String, dynamic>>()
        .map(LobbyGame.fromJson)
        .toList();
  }

  /// Joins a stake tier's queue. May return a match immediately if it completed a pairing.
  Future<QueueStatus> joinQueue(String tierId) async {
    final json = await _post('/lobby/queue', {'tierId': tierId});
    return QueueStatus.fromJson(json);
  }

  Future<void> leaveQueue(String tierId) async => _delete('/lobby/queue?tierId=$tierId');

  /// Polls queue state. Also refreshes the server-side TTL, so a client that stops asking
  /// is dropped from the queue rather than blocking the tier.
  Future<QueueStatus> queueStatus(String tierId) async {
    return QueueStatus.fromJson(await _get('/lobby/queue?tierId=$tierId'));
  }

  // ---- crash (P8) ----

  /// The current round for a tier. Between rounds this comes back with an empty
  /// `matchId` and `phase: betting` — an honest "nothing is open", not an error.
  Future<CrashRound> crashRound(String tierId) async {
    return CrashRound.fromJson(await _get('/games/crash/rounds/$tierId'));
  }

  /// Places a bet in the open round. Bounds, caps and the betting window are the
  /// server's to enforce; this call carries the intent and nothing else.
  Future<CrashBetResult> placeCrashBet(
    String tierId, {
    required int amountMinorUnits,
    int? autoCashOutX100,
  }) async {
    final json = await _post('/games/crash/rounds/$tierId/bets', {
      'amount': amountMinorUnits,
      if (autoCashOutX100 != null) 'autoCashOutX100': autoCashOutX100,
    });
    return CrashBetResult.fromJson(json);
  }

  /// Cashes out. Deliberately carries no multiplier: the server prices it from its own
  /// clock, and a client-sent number would be a number an attacker chooses (rule 1).
  Future<CrashCashOut> crashCashOut(String matchId) async {
    return CrashCashOut.fromJson(await _post('/games/crash/rounds/$matchId/cash-out', const {}));
  }

  /// Obtains a single-use WebSocket ticket (P5). Each connection needs a fresh one.
  Future<String> realtimeTicket() async {
    final json = await _post('/realtime/ticket', const {});
    return json['ticket'] as String;
  }

  Future<Money> balance() async {
    final json = await _get('/wallet/balance');
    return Money.fromJson(json['balance'] as Map<String, dynamic>);
  }

  Future<List<WalletTransaction>> transactions() async {
    final json = await _get('/wallet/transactions');
    return (json['transactions'] as List<dynamic>)
        .whereType<Map<String, dynamic>>()
        .map(WalletTransaction.fromJson)
        .toList();
  }

  /// Interim direct-credit funding (ADR-022).
  ///
  /// [idempotencyKey] must be generated once per user intent and REUSED on retry — that
  /// is what makes a timeout safe to retry without crediting twice (rule 6).
  Future<Money> addFunds({required int amountMinorUnits, required String idempotencyKey}) async {
    final json = await _post('/wallet/funding', {
      'amount': amountMinorUnits,
      'idempotencyKey': idempotencyKey,
    });
    return Money.fromJson(json['balance'] as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$baseUrl$path');
    late final http.Response response;
    try {
      response = await _http
          .post(uri, headers: await _headers(json: true), body: jsonEncode(body))
          .timeout(timeout);
    } on TimeoutException {
      throw const NetworkException('timeout');
    } catch (error) {
      throw NetworkException(error.runtimeType.toString());
    }
    return _parse(response);
  }

  Future<Map<String, dynamic>> _delete(String path) async {
    final uri = Uri.parse('$baseUrl$path');
    late final http.Response response;
    try {
      response = await _http.delete(uri, headers: await _headers()).timeout(timeout);
    } on TimeoutException {
      throw const NetworkException('timeout');
    } catch (error) {
      throw NetworkException(error.runtimeType.toString());
    }
    return _parse(response);
  }

  Future<Map<String, dynamic>> _get(String path) async {
    final uri = Uri.parse('$baseUrl$path');
    late final http.Response response;
    try {
      response = await _http.get(uri, headers: await _headers()).timeout(timeout);
    } on TimeoutException {
      throw const NetworkException('timeout');
    } catch (error) {
      // Never surface the raw transport error to the UI: it can contain hostnames and
      // internal details, and the player can do nothing with it.
      throw NetworkException(error.runtimeType.toString());
    }
    return _parse(response);
  }

  Future<Map<String, String>> _headers({bool json = false}) async {
    final headers = <String, String>{'accept': 'application/json'};
    if (json) headers['content-type'] = 'application/json';
    final token = await accessTokenProvider?.call();
    if (token != null && token.isNotEmpty) {
      headers['authorization'] = 'Bearer $token';
    }
    return headers;
  }

  Map<String, dynamic> _parse(http.Response response) {
    dynamic decoded;
    try {
      decoded = response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);
    } catch (_) {
      decoded = null;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (decoded is Map<String, dynamic>) return decoded;
      throw const ApiException(code: ApiErrorCode.internal, message: 'Malformed response');
    }
    throw ApiException.fromResponse(response.statusCode, decoded);
  }

  void close() => _http.close();
}
