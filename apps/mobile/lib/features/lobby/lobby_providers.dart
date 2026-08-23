import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/realtime_providers.dart';

/// Lobby state. The server owns queue membership and match formation; this layer only
/// asks and renders (rule 21).
final lobbyProvider = FutureProvider<List<LobbyGame>>((ref) async {
  return ref.watch(apiClientProvider).lobby();
});

/// The tier this client is currently queued for, if any.
final queuedTierProvider = StateProvider<String?>((ref) => null);

/// Keeps the lobby live (P7 debt, paid in P8).
///
/// The server already broadcasts `lobby:update` whenever a queue moves or a match forms;
/// until now nothing listened, so the lobby only changed when the player pulled to
/// refresh. Watching the room turns queue depths from a snapshot into something true.
///
/// The event is a *signal*, not the new state: it says the lobby changed, and the lobby is
/// then re-read from the server. Patching counts from a delta would mean the client
/// keeping its own version of a number the server owns.
final lobbyLiveProvider = Provider.family<void, String>((ref, gameCode) {
  ref.listen<AsyncValue<RealtimeEvent>>(
    roomEventsProvider('lobby:$gameCode'),
    (_, next) => next.whenData((event) {
      if (event.type == 'lobby:update') ref.invalidate(lobbyProvider);
    }),
    // A lobby that cannot subscribe still works by asking; it is just not live.
    onError: (_, __) {},
  );
});
