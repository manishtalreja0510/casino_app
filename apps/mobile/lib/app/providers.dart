

import 'package:api_client/api_client.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';

/// Application state layer (ADR-002).
///
/// Screens read these providers and fire events; they hold no logic themselves (rule 21).
/// Nothing here derives a balance, an outcome or a deadline — those come from the server.

/// Overridden in `main()` with the real build config, and in tests with a fake one.
final appConfigProvider = Provider<AppConfig>(
  (ref) => throw UnimplementedError('appConfigProvider must be overridden at startup'),
);

final apiClientProvider = Provider<CasinoApiClient>((ref) {
  final config = ref.watch(appConfigProvider);
  final client = CasinoApiClient(baseUrl: config.apiBaseUrl);
  ref.onDispose(client.close);
  return client;
});

enum AppConnectionState {
  online,
  offline,

  /// Device has a network but the API is not answering — worth distinguishing, because
  /// "you are offline" is a lie when it is the backend that is down.
  serverUnreachable,
}

/// Device connectivity. Reflects the radio, not whether our API is healthy — see
/// [serverReachabilityProvider] for that.
final connectivityProvider = StreamProvider<bool>((ref) async* {
  final connectivity = Connectivity();
  final initial = await connectivity.checkConnectivity();
  yield !initial.contains(ConnectivityResult.none);
  yield* connectivity.onConnectivityChanged.map(
    (results) => !results.contains(ConnectivityResult.none),
  );
});

/// Server reachability, from the health endpoint.
///
/// Deliberately separate from device connectivity so the UI can say something true:
/// offline, or reachable-but-unwell (P1's readiness endpoint reports `degraded` when
/// Redis is down but PostgreSQL is fine).
final serverReachabilityProvider = FutureProvider<HealthStatus>((ref) async {
  final client = ref.watch(apiClientProvider);
  try {
    final health = await client.health();
    return health.status;
  } on NetworkException {
    return HealthStatus.down;
  } on ApiException catch (error) {
    // A maintenance response is a healthy server deliberately refusing traffic.
    return error.isMaintenance ? HealthStatus.degraded : HealthStatus.down;
  }
});

/// Combined connection state for the UI banner.
final connectionStateProvider = Provider<AppConnectionState>((ref) {
  final online = ref.watch(connectivityProvider).value ?? true;
  if (!online) return AppConnectionState.offline;

  final server = ref.watch(serverReachabilityProvider).value;
  if (server == HealthStatus.down) return AppConnectionState.serverUnreachable;
  return AppConnectionState.online;
});
