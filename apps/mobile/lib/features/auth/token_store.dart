import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists tokens in platform-backed secure storage (Android Keystore-encrypted).
///
/// This raises the cost of extracting a token from a device — it is **not** a guarantee:
/// a rooted or instrumented device can still reach it (rule 1). The real mitigations are
/// server-side: short access-token lifetime, single-use refresh tokens, reuse detection,
/// and per-request session checks.
class TokenStore {
  const TokenStore(this._storage);

  factory TokenStore.standard() => const TokenStore(
    FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true),
    ),
  );

  final FlutterSecureStorage _storage;

  static const _accessKey = 'auth.accessToken';
  static const _refreshKey = 'auth.refreshToken';

  Future<void> save({required String accessToken, required String refreshToken}) async {
    await _storage.write(key: _accessKey, value: accessToken);
    await _storage.write(key: _refreshKey, value: refreshToken);
  }

  Future<String?> readAccessToken() => _storage.read(key: _accessKey);
  Future<String?> readRefreshToken() => _storage.read(key: _refreshKey);

  Future<void> clear() async {
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }
}
