import 'dart:async';
import 'dart:convert';

import 'package:api_client/api_client.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

/// Where requests actually go.
///
/// This exists because they once went nowhere. Every POST and DELETE in the client was
/// built from a string containing a literal `\$baseUrl\$path` — a shell-escaping artifact
/// that is valid Dart, compiles silently, passes `dart analyze`, and sends every mutating
/// request to a nonsense relative URI. Nothing caught it because no test had ever made the
/// client send a POST: the API's own suites exercise the server, and the app's widget tests
/// had never posted anything. A one-character mistake had disabled sign-in, funding,
/// queue-joining and every other write from the app.
///
/// So: one test per verb, asserting the absolute URL, forever.
void main() {
  late List<http.BaseRequest> sent;
  late CasinoApiClient client;

  setUp(() {
    sent = [];
    client = CasinoApiClient(
      baseUrl: 'https://api.example.test/api/v1',
      httpClient: _RecordingClient(sent),
    );
  });

  test('GET goes to an absolute URL under the versioned base', () async {
    await client.health();

    expect(sent.single.method, 'GET');
    expect(sent.single.url.toString(), 'https://api.example.test/api/v1/health');
  });

  test('POST goes to an absolute URL under the versioned base', () async {
    await client.realtimeTicket();

    expect(sent.single.method, 'POST');
    expect(sent.single.url.toString(), 'https://api.example.test/api/v1/realtime/ticket');
    expect(sent.single.url.isAbsolute, isTrue);
  });

  test('DELETE goes to an absolute URL, with the argument interpolated', () async {
    await client.leaveQueue('coin-duel:micro');

    expect(sent.single.method, 'DELETE');
    expect(
      sent.single.url.toString(),
      'https://api.example.test/api/v1/lobby/queue?tierId=coin-duel:micro',
    );
  });

  test('path arguments are interpolated, never left as source text', () async {
    await client.crashRound('crash:micro');
    await client.placeCrashBet('crash:micro', amountMinorUnits: 1000);
    await client.crashCashOut('match-1');

    for (final request in sent) {
      expect(request.url.isAbsolute, isTrue, reason: '${request.url}');
      expect(request.url.toString(), isNot(contains(r'$')), reason: '${request.url}');
    }
    expect(sent[1].url.path, endsWith('/bets'));
    expect(sent[2].url.path, endsWith('/match-1/cash-out'));
  });
}

class _RecordingClient extends http.BaseClient {
  _RecordingClient(this._sent);

  final List<http.BaseRequest> _sent;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    _sent.add(request);
    return http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(_bodyFor(request.url.path)))),
      200,
      headers: const {'content-type': 'application/json'},
      request: request,
    );
  }

  /// Just enough shape for each endpoint's parser; the assertions are about the URL.
  Map<String, dynamic> _bodyFor(String path) {
    if (path.endsWith('/health')) {
      return {'status': 'ok', 'version': '0', 'environment': 'test', 'time': '2026-01-01T00:00:00Z'};
    }
    if (path.endsWith('/realtime/ticket')) return {'ticket': 't'};
    if (path.contains('/games/crash/rounds')) {
      return {
        'matchId': 'm',
        'tierId': 'crash:micro',
        'phase': 'betting',
        'limits': {'betMin': 0, 'betMax': 0, 'currency': 'TST'},
        'amount': 0,
        'balance': 0,
        'cashedOutAtX100': 100,
        'payout': 0,
      };
    }
    return const {};
  }
}
