/// Crash payloads mirroring `packages/contracts/src/crash.ts` (P8).
///
/// Every multiplier here is an integer ×100, exactly as it travels on the wire. The client
/// renders these numbers and animates between them; it computes no payout it then treats
/// as truth, and it never decides whether a cash-out succeeded (rules 1, 21).
library;

import 'money.dart';

/// A multiplier ×100 — 250 is 2.50×.
extension MultiplierFormat on int {
  String get asMultiplier => '${(this / 100).toStringAsFixed(2)}x';
}

enum CrashPhase {
  /// Betting is open; the round has not lifted off.
  betting,

  /// The multiplier is rising.
  flying,

  /// Over. The seed is revealed and payouts are settled.
  crashed;

  static CrashPhase parse(String? raw) => switch (raw) {
    'flying' => CrashPhase.flying,
    'crashed' => CrashPhase.crashed,
    _ => CrashPhase.betting,
  };
}

class CrashBet {
  const CrashBet({
    required this.userId,
    required this.amount,
    this.cashedOutAtX100,
    this.payout,
  });

  final String userId;
  final Money amount;

  /// The multiplier they locked in, or null while still riding.
  final int? cashedOutAtX100;

  /// Settled winnings; null until the round crashes.
  final Money? payout;

  factory CrashBet.fromJson(Map<String, dynamic> json, String currency) => CrashBet(
    userId: json['userId'] as String? ?? '',
    amount: Money(amount: json['amount'] as int? ?? 0, currency: currency),
    cashedOutAtX100: json['cashedOutAtX100'] as int?,
    payout: json['payout'] == null
        ? null
        : Money(amount: json['payout'] as int, currency: currency),
  );
}

class CrashRound {
  const CrashRound({
    required this.matchId,
    required this.tierId,
    required this.phase,
    required this.commitment,
    required this.tickMs,
    required this.growthPerMille,
    required this.multiplierX100,
    required this.bets,
    required this.betMin,
    required this.betMax,
    required this.room,
    required this.history,
    this.betsCloseAt,
    this.startedAt,
    this.crashedAtX100,
    this.serverSeed,
  });

  final String matchId;
  final String tierId;
  final CrashPhase phase;

  /// sha256 of the server seed, published before betting opened.
  final String commitment;

  /// Milliseconds per multiplier step — the client animates from this and nothing else.
  final int tickMs;

  /// Growth per step in per-mille (10 = 1%), as the server describes its own curve.
  ///
  /// Used **only** to draw a rising number between server updates. No payout is computed
  /// from it, and any value the server sends replaces whatever was drawn: a screen showing
  /// 4.10x is a picture, not a promise (rules 2, 21).
  final int growthPerMille;

  /// The server's multiplier at the moment this was produced.
  final int multiplierX100;

  final List<CrashBet> bets;
  final Money betMin;
  final Money betMax;

  /// Realtime room carrying this tier's rounds.
  final String room;

  /// Recent crash points, newest first. Decoration only.
  final List<int> history;

  final DateTime? betsCloseAt;
  final DateTime? startedAt;
  final int? crashedAtX100;

  /// Revealed only after the round ends — this is what makes it checkable.
  final String? serverSeed;

  bool get isOpenForBets => phase == CrashPhase.betting && matchId.isNotEmpty;

  CrashBet? betFor(String? userId) {
    if (userId == null) return null;
    for (final bet in bets) {
      if (bet.userId == userId) return bet;
    }
    return null;
  }

  /// The realtime room carrying a tier's rounds. Mirrors `crashRoundRoom` in contracts.
  static String roomFor(String tierId) => 'round:$tierId';

  /// The multiplier to *draw* `elapsed` into the flight.
  ///
  /// This redraws the server's curve from the parameters the server sent; it is never the
  /// number a cash-out is worth. The server prices that from its own clock, and it may
  /// well differ by a tick — which is why nothing in the app compares the two or shows a
  /// payout derived from this.
  int drawnMultiplierAt(Duration elapsed) {
    if (elapsed.isNegative || tickMs <= 0) return 100;
    final steps = elapsed.inMilliseconds ~/ tickMs;
    var value = 100;
    for (var i = 0; i < steps; i++) {
      final step = (value * growthPerMille) ~/ 1000;
      value += step < 1 ? 1 : step;
      if (value >= 1000000) break;
    }
    return value;
  }

  factory CrashRound.fromJson(Map<String, dynamic> json) {
    final limits = (json['limits'] as Map<String, dynamic>?) ?? const {};
    final currency = limits['currency'] as String? ?? Money.testCurrency;

    return CrashRound(
      matchId: json['matchId'] as String? ?? '',
      tierId: json['tierId'] as String? ?? '',
      phase: CrashPhase.parse(json['phase'] as String?),
      commitment: json['commitment'] as String? ?? '',
      tickMs: json['tickMs'] as int? ?? 100,
      growthPerMille: json['growthPerMille'] as int? ?? 10,
      multiplierX100: json['multiplierX100'] as int? ?? 100,
      bets: (json['bets'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((bet) => CrashBet.fromJson(bet, currency))
          .toList(),
      betMin: Money(amount: limits['betMin'] as int? ?? 0, currency: currency),
      betMax: Money(amount: limits['betMax'] as int? ?? 0, currency: currency),
      room: json['room'] as String? ?? 'round:${json['tierId'] ?? ''}',
      history: (json['history'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((entry) => entry['crashedAtX100'] as int? ?? 0)
          .where((value) => value > 0)
          .toList(),
      betsCloseAt: _time(json['betsCloseAt']),
      startedAt: _time(json['startedAt']),
      crashedAtX100: json['crashedAtX100'] as int?,
      serverSeed: json['serverSeed'] as String?,
    );
  }

  static DateTime? _time(dynamic value) =>
      value is int && value > 0 ? DateTime.fromMillisecondsSinceEpoch(value) : null;
}

class CrashBetResult {
  const CrashBetResult({required this.matchId, required this.amount, required this.balance, this.autoCashOutX100});

  final String matchId;
  final Money amount;
  final Money balance;
  final int? autoCashOutX100;

  factory CrashBetResult.fromJson(Map<String, dynamic> json) => CrashBetResult(
    matchId: json['matchId'] as String? ?? '',
    amount: Money(amount: json['amount'] as int? ?? 0, currency: Money.testCurrency),
    balance: Money(amount: json['balance'] as int? ?? 0, currency: Money.testCurrency),
    autoCashOutX100: json['autoCashOutX100'] as int?,
  );
}

class CrashCashOut {
  const CrashCashOut({required this.matchId, required this.cashedOutAtX100, required this.payout});

  final String matchId;
  final int cashedOutAtX100;
  final Money payout;

  factory CrashCashOut.fromJson(Map<String, dynamic> json) => CrashCashOut(
    matchId: json['matchId'] as String? ?? '',
    cashedOutAtX100: json['cashedOutAtX100'] as int? ?? 100,
    payout: Money(amount: json['payout'] as int? ?? 0, currency: Money.testCurrency),
  );
}
