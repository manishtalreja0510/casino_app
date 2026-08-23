import 'dart:async';
import 'dart:convert';

import 'package:api_client/api_client.dart';
import 'package:casino_app/app/providers.dart';
import 'package:casino_app/app/realtime_providers.dart';
import 'package:casino_app/config/app_config.dart';
import 'package:casino_app/features/auth/auth_controller.dart';
import 'package:casino_app/features/auth/auth_state.dart';
import 'package:casino_app/features/poker/poker_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:ui_kit/ui_kit.dart';

import 'fakes.dart';

/// The poker table as a shell.
///
/// The assertions worth making here are about restraint: the screen offers exactly the
/// actions the server said were legal, shows exactly the cards the server sent, and sends
/// intents rather than decisions (rules 1, 21).
void main() {
  const tableId = 'table-1';

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  ({Widget widget, ProviderContainer container, List<String> bodies}) harness({
    required Map<String, dynamic> table,
    String userId = 'alice',
  }) {
    final bodies = <String>[];

    final client = _StubClient((request) async {
      if (request is http.Request) bodies.add(request.body);
      return http.Response(jsonEncode(table), 200, headers: {'content-type': 'application/json'});
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
          home: const PokerScreen(tableId: tableId),
        ),
      ),
      container: container,
      bodies: bodies,
    );
  }

  Map<String, dynamic> tablePayload({
    List<Map<String, dynamic>> seats = const [],
    Map<String, dynamic>? hand,
  }) => {
    'tableId': tableId,
    'name': 'Micro 1/2',
    'tierId': 'poker:micro',
    'seatCount': 6,
    'currency': 'TST',
    'blinds': {'sb': 100, 'bb': 200},
    'buyIn': {'min': 8000, 'max': 20000},
    'room': 'round:table-$tableId',
    'buttonSeat': 0,
    'handNo': 3,
    'matchId': hand == null ? null : 'match-1',
    'seats': seats,
    'hand': hand,
    'history': const [],
  };

  Map<String, dynamic> seat(String userId, {int seatNo = 0, int stack = 20000}) => {
    'seatNo': seatNo,
    'userId': userId,
    'stack': stack,
    'state': 'seated',
  };

  testWidgets('offers a buy-in with the server’s bounds when not seated', (tester) async {
    final h = harness(table: tablePayload());
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.textContaining('Buy in between'), findsOneWidget);
    expect(find.text('Sit down'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('shows the caller’s own cards and nobody else’s', (tester) async {
    final h = harness(
      table: tablePayload(
        seats: [seat('alice', seatNo: 0), seat('bob', seatNo: 1)],
        hand: {
          'street': 'flop',
          'board': ['2h', '7d', '9c'],
          'pot': 600,
          'currentBet': 0,
          'minRaise': 200,
          'blinds': {'sb': 100, 'bb': 200},
          'buttonSeat': 0,
          'toAct': 'bob',
          'deadlineAt': null,
          'seats': [
            {
              'userId': 'alice',
              'seat': 0,
              'stack': 19800,
              'committed': 200,
              'streetBet': 0,
              'folded': false,
              'allIn': false,
              'cards': null,
            },
            {
              'userId': 'bob',
              'seat': 1,
              'stack': 19800,
              'committed': 200,
              'streetBet': 0,
              'folded': false,
              'allIn': false,
              'cards': null,
            },
          ],
          'result': null,
          'you': {
            'seat': 0,
            'cards': ['Ah', 'Kd'],
            'stack': 19800,
            'committed': 200,
            'streetBet': 0,
            'folded': false,
            'allIn': false,
            'timebankMs': 30000,
            'legal': null,
          },
        },
      ),
    );

    await tester.pumpWidget(h.widget);
    await settle(tester);

    // Alice's own cards are rendered…
    expect(find.text('Ah Kd'), findsOneWidget);
    // …and the payload simply never contained anyone else's, so there is nothing to hide.
    expect(find.textContaining('2h  7d  9c'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('offers exactly the actions the server called legal', (tester) async {
    final h = harness(
      table: tablePayload(
        seats: [seat('alice')],
        hand: {
          'street': 'preflop',
          'board': const <String>[],
          'pot': 300,
          'currentBet': 200,
          'minRaise': 200,
          'blinds': {'sb': 100, 'bb': 200},
          'buttonSeat': 0,
          'toAct': 'alice',
          'deadlineAt': null,
          'seats': const <Map<String, dynamic>>[],
          'result': null,
          'you': {
            'seat': 0,
            'cards': ['Ah', 'Kd'],
            'stack': 19800,
            'committed': 200,
            'streetBet': 100,
            'folded': false,
            'allIn': false,
            'timebankMs': 30000,
            'legal': {
              'canFold': true,
              'canCheck': false,
              'canCall': true,
              'callAmount': 100,
              'canBet': false,
              'canRaise': true,
              'minRaiseTo': 400,
              'maxRaiseTo': 19900,
            },
          },
        },
      ),
    );

    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Fold'), findsOneWidget);
    expect(find.text('Call 100'), findsOneWidget);
    expect(find.text('Check'), findsNothing); // not offered, because it is not legal
    expect(find.textContaining('min 400'), findsOneWidget);

    h.container.dispose();
  });

  testWidgets('explains why raising is closed instead of showing a dead button', (tester) async {
    final h = harness(
      table: tablePayload(
        seats: [seat('alice')],
        hand: {
          'street': 'preflop',
          'board': const <String>[],
          'pot': 500,
          'currentBet': 260,
          'minRaise': 200,
          'blinds': {'sb': 100, 'bb': 200},
          'buttonSeat': 0,
          'toAct': 'alice',
          'deadlineAt': null,
          'seats': const <Map<String, dynamic>>[],
          'result': null,
          'you': {
            'seat': 0,
            'cards': ['Ah', 'Kd'],
            'stack': 19800,
            'committed': 200,
            'streetBet': 200,
            'folded': false,
            'allIn': false,
            'timebankMs': 30000,
            'legal': {
              'canFold': true,
              'canCheck': false,
              'canCall': true,
              'callAmount': 60,
              'canBet': false,
              'canRaise': false,
              'minRaiseTo': 460,
              'maxRaiseTo': 20000,
              'raiseBlockedReason': 'an all-in below a full raise does not reopen the action',
            },
          },
        },
      ),
    );

    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.textContaining('does not reopen the action'), findsOneWidget);
    expect(find.text('Raise'), findsNothing);

    h.container.dispose();
  });

  testWidgets('sends an action as an intent, with no outcome attached', (tester) async {
    final h = harness(
      table: tablePayload(
        seats: [seat('alice')],
        hand: {
          'street': 'preflop',
          'board': const <String>[],
          'pot': 300,
          'currentBet': 200,
          'minRaise': 200,
          'blinds': {'sb': 100, 'bb': 200},
          'buttonSeat': 0,
          'toAct': 'alice',
          'deadlineAt': null,
          'seats': const <Map<String, dynamic>>[],
          'result': null,
          'you': {
            'seat': 0,
            'cards': ['Ah', 'Kd'],
            'stack': 19800,
            'committed': 200,
            'streetBet': 100,
            'folded': false,
            'allIn': false,
            'timebankMs': 30000,
            'legal': {
              'canFold': true,
              'canCheck': false,
              'canCall': true,
              'callAmount': 100,
              'canBet': false,
              'canRaise': false,
              'minRaiseTo': 0,
              'maxRaiseTo': 0,
            },
          },
        },
      ),
    );

    await tester.pumpWidget(h.widget);
    await settle(tester);

    await tester.tap(find.text('Fold'));
    await settle(tester);

    final action = h.bodies.firstWhere((body) => body.contains('fold'));
    expect(jsonDecode(action), {'type': 'fold'});

    h.container.dispose();
  });

  testWidgets('warns that standing up mid-hand does not retrieve committed chips', (tester) async {
    final h = harness(table: tablePayload(seats: [seat('alice')]));
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.text('Stand up'), findsOneWidget);
    expect(find.textContaining('chips already in the pot stay there'), findsOneWidget);

    h.container.dispose();
  });
}

class _StubClient extends http.BaseClient {
  _StubClient(this._handler);

  final Future<http.Response> Function(http.BaseRequest request) _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await _handler(request);
    return http.StreamedResponse(
      Stream.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
      request: request,
    );
  }
}
