import 'dart:async';

import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';

/// The realtime layer, wired into the app (P8).
///
/// P5 built the client; nothing used it until a game needed live rounds. Two properties
/// carry over from the server side and must not be softened here:
///
///  - **A ticket is single-use.** Every connection needs a fresh one from the API, which
///    is why the socket's own auto-reconnect is disabled and reconnection is done here.
///  - **The server's sequence is the truth.** The client tracks the highest sequence it
///    applied and asks the server to fill gaps; it never invents the state it missed.

/// Origin without the `/api/v1` prefix — Socket.IO attaches at the namespace.
String _originOf(String apiBaseUrl) {
  final uri = Uri.parse(apiBaseUrl);
  return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null).toString();
}

final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final config = ref.watch(appConfigProvider);
  final client = RealtimeClient(baseUrl: _originOf(config.apiBaseUrl));
  ref.onDispose(client.dispose);
  return client;
});

/// Connects once, lazily, for whoever needs a room first.
///
/// Kept alive by its listeners: when the last room subscription goes away the connection
/// is disposed with it, so a player sitting on the wallet screen holds no socket.
final realtimeConnectionProvider = FutureProvider<RealtimeClient>((ref) async {
  final api = ref.watch(apiClientProvider);
  final client = ref.watch(realtimeClientProvider);

  final ticket = await api.realtimeTicket();
  await client.connect(ticket);

  ref.onDispose(client.disconnect);
  return client;
});

/// Live events for one room.
///
/// Joining is a request the server may refuse — room membership is authorised server-side
/// against the roster, never from what the client asks for. A refusal surfaces as a
/// stream error rather than as silence.
final roomEventsProvider = StreamProvider.family<RealtimeEvent, String>((ref, room) async* {
  final client = await ref.watch(realtimeConnectionProvider.future);

  final joined = await client.joinRoom(room);
  if (!joined) throw StateError('The server refused this room');

  ref.onDispose(() => unawaited(client.leaveRoom(room)));

  yield* client.events.where((event) => event.room == room);
});
