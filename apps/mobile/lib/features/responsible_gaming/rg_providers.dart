import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/realtime_providers.dart';

/// Responsible-gaming state.
///
/// One provider, holding whatever the server last said. There is deliberately no local
/// copy of a limit, no cached "remaining", and no client-side idea of whether play is
/// allowed: every one of those is a decision the server makes on the request itself, and a
/// second copy here could only ever be wrong in the player's favour (rules 1, 21).
final rgStatusProvider = FutureProvider<RgStatus>((ref) async {
  return ref.watch(apiClientProvider).rgStatus();
});

/// The event a reality check arrives on. Server-pushed to the player's own room.
const realityCheckEvent = 'rg:reality_check';

/// Reality checks, as they arrive.
///
/// Subscribed to the realtime *client* rather than to `realtimeConnectionProvider`, and
/// that is deliberate on both counts. Watching the connection provider would hold a socket
/// open for the whole app — undoing P8's rule that a player reading their wallet holds no
/// connection — while watching the client means checks are delivered whenever a connection
/// happens to exist, which is exactly while somebody is playing.
///
/// No join is requested: the server puts every socket in the player's own room when it
/// connects, so this is a filter over what already arrives, not a subscription the client
/// could be refused (or forget to make).
final realityCheckProvider = StreamProvider<RealtimeEvent>((ref) {
  return ref
      .watch(realtimeClientProvider)
      .events
      .where((event) => event.type == realityCheckEvent);
});
