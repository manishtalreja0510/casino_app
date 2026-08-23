import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_error.dart';
import 'health.dart';

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

  Future<Map<String, String>> _headers() async {
    final headers = <String, String>{'accept': 'application/json'};
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
