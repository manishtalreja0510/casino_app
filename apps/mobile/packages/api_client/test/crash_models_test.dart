import 'package:api_client/api_client.dart';
import 'package:test/test.dart';

/// The Crash contract as it arrives on the wire.
///
/// The parsing matters more than it looks: every multiplier is an integer ×100 and every
/// amount is integer minor units, and a client that quietly turned either into a double
/// would be doing money arithmetic in floating point (rule 4).
void main() {
  Map<String, dynamic> round({
    String phase = 'flying',
    int multiplierX100 = 250,
    int? crashedAtX100,
    String? serverSeed,
  }) => {
    'matchId': 'match-1',
    'tierId': 'crash:micro',
    'phase': phase,
    'commitment': 'a' * 64,
    'betsCloseAt': 1700000000000,
    'startedAt': 1700000001000,
    'tickMs': 100,
    'growthPerMille': 10,
    'multiplierX100': multiplierX100,
    'crashedAtX100': crashedAtX100,
    'serverSeed': serverSeed,
    'bets': [
      {'userId': 'alice', 'amount': 1000, 'cashedOutAtX100': 200, 'payout': 2000},
      {'userId': 'bob', 'amount': 2500, 'cashedOutAtX100': null, 'payout': null},
    ],
    'limits': {'betMin': 1000, 'betMax': 25000, 'currency': 'TST'},
    'room': 'round:crash:micro',
    'history': [
      {'matchId': 'm0', 'crashedAtX100': 431},
      {'matchId': 'm-1', 'crashedAtX100': 100},
    ],
  };

  group('CrashRound', () {
    test('parses a flying round without a seed or a crash point', () {
      final parsed = CrashRound.fromJson(round());

      expect(parsed.phase, CrashPhase.flying);
      expect(parsed.multiplierX100, 250);
      expect(parsed.crashedAtX100, isNull);
      expect(parsed.serverSeed, isNull);
      expect(parsed.betMin.amount, 1000);
      expect(parsed.betMax.currency, 'TST');
      expect(parsed.history, [431, 100]);
      expect(parsed.isOpenForBets, isFalse);
    });

    test('parses a settled round, seed and all', () {
      final parsed = CrashRound.fromJson(
        round(phase: 'crashed', crashedAtX100: 512, serverSeed: 'b' * 64),
      );

      expect(parsed.phase, CrashPhase.crashed);
      expect(parsed.crashedAtX100, 512);
      expect(parsed.serverSeed, 'b' * 64);
    });

    test('treats an unknown phase as betting rather than guessing', () {
      expect(CrashRound.fromJson(round(phase: 'something-new')).phase, CrashPhase.betting);
    });

    test('reports "nothing is open" honestly between rounds', () {
      final parsed = CrashRound.fromJson({
        'matchId': '',
        'tierId': 'crash:micro',
        'phase': 'betting',
        'limits': {'betMin': 1000, 'betMax': 25000, 'currency': 'TST'},
      });

      expect(parsed.isOpenForBets, isFalse);
      expect(parsed.multiplierX100, 100);
      expect(parsed.bets, isEmpty);
    });

    test('finds the caller’s own bet and nobody else’s', () {
      final parsed = CrashRound.fromJson(round());

      expect(parsed.betFor('alice')?.cashedOutAtX100, 200);
      expect(parsed.betFor('bob')?.payout, isNull);
      expect(parsed.betFor('mallory'), isNull);
      expect(parsed.betFor(null), isNull);
    });

    test('keeps every amount an integer in minor units', () {
      final parsed = CrashRound.fromJson(round());
      expect(parsed.bets.first.amount.amount, isA<int>());
      expect(parsed.bets.first.payout!.amount, 2000);
    });
  });

  group('the drawn curve', () {
    final parsed = CrashRound.fromJson(round());

    test('starts at 1.00x and rises, never falling', () {
      expect(parsed.drawnMultiplierAt(Duration.zero), 100);

      var previous = 100;
      for (var ms = 0; ms < 20000; ms += 100) {
        final value = parsed.drawnMultiplierAt(Duration(milliseconds: ms));
        expect(value, greaterThanOrEqualTo(previous));
        previous = value;
      }
    });

    test('is integer-only, and does not move between ticks', () {
      expect(parsed.drawnMultiplierAt(const Duration(milliseconds: 99)), 100);
      expect(
        parsed.drawnMultiplierAt(const Duration(milliseconds: 150)),
        parsed.drawnMultiplierAt(const Duration(milliseconds: 100)),
      );
    });

    test('treats a clock that went backwards as lift-off', () {
      expect(parsed.drawnMultiplierAt(const Duration(seconds: -30)), 100);
    });

    test('follows the parameters the server sent, not a copy of the rules', () {
      final slower = CrashRound.fromJson({...round(), 'growthPerMille': 1, 'tickMs': 1000});
      final faster = CrashRound.fromJson({...round(), 'growthPerMille': 100, 'tickMs': 10});

      const after = Duration(seconds: 5);
      expect(faster.drawnMultiplierAt(after), greaterThan(slower.drawnMultiplierAt(after)));
    });
  });

  group('multiplier formatting', () {
    test('renders integers ×100 the way players read them', () {
      expect(100.asMultiplier, '1.00x');
      expect(1234.asMultiplier, '12.34x');
      expect(10000.asMultiplier, '100.00x');
    });
  });
}
