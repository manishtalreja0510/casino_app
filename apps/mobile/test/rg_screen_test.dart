import 'dart:convert';

import 'package:api_client/api_client.dart';
import 'package:casino_app/app/providers.dart';
import 'package:casino_app/config/app_config.dart';
import 'package:casino_app/features/auth/auth_controller.dart';
import 'package:casino_app/features/auth/auth_state.dart';
import 'package:casino_app/features/responsible_gaming/rg_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:ui_kit/ui_kit.dart';

import 'fakes.dart';

/// The responsible-gaming screen.
///
/// What is worth asserting here is not that the widgets appear. It is that the screen
/// **decides nothing**: it never computes whether a limit allows an action, never hides a
/// break it does not like the look of, and never sends an irreversible request without the
/// player having typed the confirmation. Everything else is the server's, and this screen
/// is only allowed to describe it (rules 1, 21).
void main() {
  ({Widget widget, ProviderContainer container, List<({String method, String url, String body})>
      requests})
  harness({required Map<String, dynamic> status, Map<String, dynamic>? postResponse}) {
    final requests = <({String method, String url, String body})>[];

    final client = _StubClient((request) async {
      requests.add((
        method: request.method,
        url: request.url.path,
        body: request is http.Request ? request.body : '',
      ));
      if (request.method == 'POST') {
        return http.Response(
          jsonEncode(postResponse ?? {'effective': 'immediate', 'effectiveAt': null}),
          201,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode(status),
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

    return (
      widget: UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.placeholderDark(),
          home: const ResponsibleGamingScreen(),
        ),
      ),
      container: container,
      requests: requests,
    );
  }

  Map<String, dynamic> statusPayload({
    List<Map<String, dynamic>> limits = const [],
    Map<String, dynamic>? exclusion,
    List<Map<String, dynamic>> events = const [],
    int intervalMs = 30 * 60 * 1000,
  }) => {
    'limits': limits,
    'exclusion': exclusion,
    'history': exclusion == null ? const [] : [exclusion],
    'realityCheck': {
      'intervalMs': intervalMs,
      'lastShownAt': null,
      'acknowledged': true,
    },
    'events': events,
  };

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  /// Brings a control into view before tapping it.
  ///
  /// The screen is a long list and the test viewport is small, so anything below the
  /// reality-check section is not built until it is scrolled to. Nothing about the
  /// behaviour under test — just the difference between a phone screen and this one.
  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(finder, 200, scrollable: find.byType(Scrollable).first);
    await settle(tester);
  }

  testWidgets('shows a limit exactly as the server counted it', (tester) async {
    final h = harness(
      status: statusPayload(
        limits: [
          {
            'type': 'wager',
            'period': 'day',
            'amount': 50000,
            'used': 20000,
            'pendingAmount': null,
            'pendingEffectiveAt': null,
          },
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    // 500.00 limit, 200.00 used, 300.00 left — the arithmetic the server did, rendered.
    expect(find.textContaining('500.00 TST'), findsOneWidget);
    expect(find.textContaining('200.00 TST used'), findsOneWidget);
    expect(find.textContaining('300.00 TST left'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('says when a higher limit takes effect, and offers to cancel it', (tester) async {
    final effective = DateTime.now().toUtc().add(const Duration(hours: 24));
    final h = harness(
      status: statusPayload(
        limits: [
          {
            'type': 'wager',
            'period': 'day',
            'amount': 10000,
            'used': 0,
            'pendingAmount': 90000,
            'pendingEffectiveAt': effective.toIso8601String(),
          },
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    // The pending one is described as pending, and the one in force is still the old one.
    expect(find.textContaining('900.00 TST takes effect'), findsOneWidget);
    expect(find.textContaining('100.00 TST'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('shows the break in force and tells the player it cannot be shortened',
      (tester) async {
    final h = harness(
      status: statusPayload(
        exclusion: {
          'kind': 'cool_off',
          'startsAt': DateTime.now().toUtc().toIso8601String(),
          'endsAt': DateTime.now().toUtc().add(const Duration(days: 7)).toIso8601String(),
        },
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    expect(find.textContaining('taking a break until'), findsOneWidget);
    expect(find.textContaining('cannot be shortened'), findsOneWidget);
    // And the controls that would start another one are gone — not disabled, gone. There is
    // nothing to offer somebody who is already excluded.
    expect(find.text('Take 24 hours off'), findsNothing);
    expect(find.text('Self-exclude permanently'), findsNothing);
    h.container.dispose();
  });

  testWidgets('will not start a break without the confirmation typed', (tester) async {
    final h = harness(status: statusPayload());
    await tester.pumpWidget(h.widget);
    await settle(tester);

    await reveal(tester, find.text('Self-exclude permanently'));
    await tester.tap(find.text('Self-exclude permanently'));
    await settle(tester);

    // Confirming with the box empty does nothing at all.
    await tester.tap(find.text('Confirm'));
    await settle(tester);

    expect(h.requests.where((r) => r.method == 'POST'), isEmpty);
    h.container.dispose();
  });

  testWidgets('sends the break once the words are typed, and asks the server again',
      (tester) async {
    final h = harness(
      status: statusPayload(),
      postResponse: {'endsAt': null},
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    await reveal(tester, find.text('Self-exclude permanently'));
    await tester.tap(find.text('Self-exclude permanently'));
    await settle(tester);
    await tester.enterText(find.byType(TextField), 'I understand');
    await tester.tap(find.text('Confirm'));
    await settle(tester);

    final posted = h.requests.where((r) => r.method == 'POST').toList();
    expect(posted, hasLength(1));
    expect(posted.first.url, endsWith('/rg/exclusions'));
    final body = jsonDecode(posted.first.body) as Map<String, dynamic>;
    expect(body['kind'], 'self_exclusion');
    expect(body['durationMs'], isNull);
    // The server's own friction, sent as well as shown: neither side trusts the other's.
    expect(body['confirm'], 'I understand');

    // And the screen re-reads rather than assuming what the server did with it.
    expect(h.requests.where((r) => r.method == 'GET').length, greaterThan(1));
    h.container.dispose();
  });

  testWidgets('tells the player a loosened limit is not in force yet', (tester) async {
    final effective = DateTime.now().toUtc().add(const Duration(hours: 24));
    final h = harness(
      status: statusPayload(),
      postResponse: {'effective': 'pending', 'effectiveAt': effective.toIso8601String()},
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    await tester.tap(find.text('Set').first);
    await settle(tester);
    await tester.enterText(find.byType(TextField), '900');
    await tester.tap(find.text('Save'));
    await settle(tester);

    expect(find.textContaining('still applies until then'), findsOneWidget);
    h.container.dispose();
  });

  testWidgets('renders the record without inventing entries for it', (tester) async {
    final h = harness(
      status: statusPayload(
        events: [
          {
            'type': 'cool_off.started',
            'at': DateTime.now().toUtc().toIso8601String(),
            'payload': const {},
          },
          {
            'type': 'something.the.client.has.never.heard.of',
            'at': DateTime.now().toUtc().toIso8601String(),
            'payload': const {},
          },
        ],
      ),
    );
    await tester.pumpWidget(h.widget);
    await settle(tester);

    await reveal(tester, find.text('Break started'));
    expect(find.text('Break started'), findsOneWidget);
    // An unknown type is shown as itself rather than dropped: a record with a silent gap
    // in it is worse than one with a word the player has to ask about.
    expect(find.text('something.the.client.has.never.heard.of'), findsOneWidget);
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
