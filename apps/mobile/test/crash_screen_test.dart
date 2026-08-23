import 'dart:async';
import 'dart:convert';

import 'package:api_client/api_client.dart';
import 'package:casino_app/app/providers.dart';
import 'package:casino_app/app/realtime_providers.dart';
import 'package:casino_app/config/app_config.dart';
import 'package:casino_app/features/auth/auth_controller.dart';
import 'package:casino_app/features/auth/auth_state.dart';
import 'package:casino_app/features/crash/crash_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:ui_kit/ui_kit.dart';

import 'fakes.dart';

/// The Crash screen as a shell (P8).
///
/// What is worth asserting here is not that it looks right — that is P19's problem — but
/// that it never decides anything: betting is open because the *server* says so, the
/// number on screen is a picture, and a rejection is shown in the server's words rather
/// than pre-empted by client-side rules (rules 1, 21).
void main() {
  const tierId = 'crash:micro';

  /// Lets pending futures resolve.
  ///
  /// `pumpAndSettle` is not usable here: the screen animates the multiplier on a periodic
  /// timer, so there is deliberately never a frame where nothing is scheduled.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  /// A stub API that answers `GET /games/crash/rounds/...` with a fixed round and records
  /// every request, so a test can assert what the screen actually asked for.
  ({Widget widget, List<String> requests, ProviderContainer container}) harness({
    required Map<String, dynamic> round,
    Map<String, dynamic>? betResponse,
    int betStatus = 200,
    String userId = 'alice',
  }) {
    final requests = <String>[];

    final client = _StubClient((request) async {
      requests.add('${request.method} ${request.url.path}');

      if (request.url.path.endsWith('/bets')) {
        return http.Response(jsonEncode(betResponse ?? const {}), betStatus,
            headers: {'content-type': 'application/json'});
      }
      if (request.url.path.contains('/games/crash/rounds/')) {
        return http.Response(jsonEncode(round), 200,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'amount': 0, 'currency': 'TST'}), 200,
          headers: {'content-type': 'application/json'});
    });

    final container = ProviderContainer(
      overrides: [
        appConfigProvider.overrideWithValue(AppConfig.forTesting()),
        apiClientProvider.overrideWithValue(
          CasinoApiClient(baseUrl: 'http://127.0.0.1:0/api/v1', httpClient: client),
        ),
        // No socket in a widget test: the screen must work from what it can ask for.
        roomEventsProvider.overrideWith((ref, room) => const Stream<RealtimeEvent>.empty()),
        authControllerProvider.overrideWith(
          (ref) => FakeAuthController(
            AuthState.signedIn(
              AuthUser(
                id: userId,
                email: 'a@example.test',
                displayName: 'Alice',
                status: 'active',
                kycLevel: 'L0',
              ),
            ),
          ),
        ),
      ],
    );

    return (
      widget: UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.placeholderDark(),
          home: const CrashScreen(tierId: tierId),
        ),
      ),
      requests: requests,
      container: container,
    );
  }

  Map<String, dynamic> round({
    String phase = 'betting',
    String matchId = 'match-1',
    List<Map<String, dynamic>> bets = const [],
    int? crashedAtX100,
    String? serverSeed,
  }) => {
    'matchId': matchId,
    'tierId': tierId,
    'phase': phase,
    'commitment': 'c' * 64,
    'betsCloseAt': DateTime.now().millisecondsSinceEpoch + 5000,
    'startedAt': phase == 'betting' ? null : DateTime.now().millisecondsSinceEpoch,
    'tickMs': 100,
    'growthPerMille': 10,
    'multiplierX100': 100,
    'crashedAtX100': crashedAtX100,
    'serverSeed': serverSeed,
    'bets': bets,
    'limits': {'betMin': 1000, 'betMax': 25000, 'currency': 'TST'},
    'room': 'round:$tierId',
    'history': [
      {'matchId': 'm0', 'crashedAtX100': 431},
    ],
  };

  testWidgets('shows the open betting window and the tier bounds the server set',
      (tester) async {
    final h = harness(round: round());
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Betting is open'), findsOneWidget);
    expect(find.textContaining('Bet between'), findsOneWidget);
    expect(find.text('Place bet'), findsOneWidget);
    expect(find.text('4.31x'), findsOneWidget); // history strip

    h.container.dispose();
  });

  testWidgets('offers no bet button once the round is flying', (tester) async {
    final h = harness(round: round(phase: 'flying'));
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('In flight'), findsOneWidget);
    final button = tester.widget<AppButton>(find.widgetWithText(AppButton, 'Place bet'));
    expect(button.onPressed, isNull);

    h.container.dispose();
  });

  testWidgets('offers a cash-out only while the player is actually riding', (tester) async {
    final h = harness(
      round: round(
        phase: 'flying',
        bets: [
          {'userId': 'alice', 'amount': 5000, 'cashedOutAtX100': null, 'payout': null},
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Cash out'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('stops offering a cash-out once the server says it happened', (tester) async {
    final h = harness(
      round: round(
        phase: 'flying',
        bets: [
          {'userId': 'alice', 'amount': 5000, 'cashedOutAtX100': 250, 'payout': null},
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Cash out'), findsNothing);
    expect(find.text('2.50x'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('shows the outcome the server settled, not one it worked out itself',
      (tester) async {
    final h = harness(
      round: round(
        phase: 'crashed',
        crashedAtX100: 512,
        serverSeed: 's' * 64,
        bets: [
          {'userId': 'alice', 'amount': 5000, 'cashedOutAtX100': 250, 'payout': 12500},
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Crashed'), findsOneWidget);
    expect(find.text('5.12x'), findsOneWidget);
    expect(find.textContaining('You won'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('keeps the seed out of sight until the round is over', (tester) async {
    final flying = harness(round: round(phase: 'flying'));
    await tester.pumpWidget(flying.widget);
    await settle(tester);
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pump();

    expect(find.text('revealed after the round'), findsOneWidget);
    flying.container.dispose();

    final crashed = harness(
      round: round(phase: 'crashed', crashedAtX100: 300, serverSeed: 'd' * 64),
    );
    await tester.pumpWidget(crashed.widget);
    await settle(tester);
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pump();

    expect(find.text('d' * 64), findsOneWidget);
    crashed.container.dispose();
  });

  testWidgets('reports a refusal in the server’s words', (tester) async {
    final h = harness(
      round: round(),
      betStatus: 409,
      betResponse: {
        'error': {
          'code': 'GAME_INVALID_ACTION',
          'message': 'This round cannot take that bet: the round has taken its maximum stake',
          'traceId': 'trace-1',
        },
      },
    );

    await tester.pumpWidget(h.widget);
    await settle(tester);

    await tester.enterText(find.byType(TextField).first, '5000');
    await tester.tap(find.text('Place bet'));
    await settle(tester);

    expect(find.textContaining('maximum stake'), findsOneWidget);
    expect(h.requests, contains('POST /api/v1/games/crash/rounds/$tierId/bets'));

    h.container.dispose();
  });

  testWidgets('sends the cash-out with no multiplier attached', (tester) async {
    final bodies = <String>[];
    final client = _StubClient((request) async {
      if (request is http.Request) bodies.add(request.body);
      if (request.url.path.endsWith('/cash-out')) {
        return http.Response(
          jsonEncode({'matchId': 'match-1', 'cashedOutAtX100': 248, 'payout': 12400}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode(round(
          phase: 'flying',
          bets: [
            {'userId': 'alice', 'amount': 5000, 'cashedOutAtX100': null, 'payout': null},
          ],
        )),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final container = ProviderContainer(
      overrides: [
        appConfigProvider.overrideWithValue(AppConfig.forTesting()),
        apiClientProvider.overrideWithValue(
          CasinoApiClient(baseUrl: 'http://127.0.0.1:0/api/v1', httpClient: client),
        ),
        roomEventsProvider.overrideWith((ref, room) => const Stream<RealtimeEvent>.empty()),
        authControllerProvider.overrideWith(
          (ref) => FakeAuthController(
            AuthState.signedIn(
              AuthUser(
                id: 'alice',
                email: 'a@example.test',
                displayName: 'Alice',
                status: 'active',
                kycLevel: 'L0',
              ),
            ),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: AppTheme.placeholderDark(), home: const CrashScreen(tierId: tierId)),
      ),
    );
    await settle(tester);

    await tester.tap(find.text('Cash out'));
    await settle(tester);

    // The request carries intent and nothing else: a multiplier in the body would be a
    // number the player's device chose.
    expect(bodies.any((body) => body.contains('multiplier')), isFalse);
    expect(find.textContaining('2.48x'), findsOneWidget);

    container.dispose();
  });
}

/// A `http.Client` that answers from a callback. Small enough to keep in the test, and it
/// avoids pulling a mocking framework in for one shape of stub.
class _StubClient extends http.BaseClient {
  _StubClient(this._handler);

  final Future<http.Response> Function(http.BaseRequest request) _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request is http.Request) {
      // Read the body before responding so assertions can see it.
      request.finalize();
    }
    final response = await _handler(request);
    return http.StreamedResponse(
      Stream.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
      request: request,
    );
  }
}
