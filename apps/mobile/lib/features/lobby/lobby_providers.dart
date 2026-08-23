import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';

/// Lobby state. The server owns queue membership and match formation; this layer only
/// asks and renders (rule 21).
final lobbyProvider = FutureProvider<List<LobbyGame>>((ref) async {
  return ref.watch(apiClientProvider).lobby();
});

/// The tier this client is currently queued for, if any.
final queuedTierProvider = StateProvider<String?>((ref) => null);
