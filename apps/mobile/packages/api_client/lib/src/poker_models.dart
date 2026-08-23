/// Poker payloads mirroring `packages/contracts/src/poker.ts` (P9).
///
/// Chips are integer minor units, like every amount in this system. Nothing here computes
/// a pot, a legal raise, or a winner — those arrive decided (rules 1, 21).
library;

import 'money.dart';

enum PokerStreet {
  preflop,
  flop,
  turn,
  river,
  complete;

  static PokerStreet parse(String? raw) => switch (raw) {
    'flop' => PokerStreet.flop,
    'turn' => PokerStreet.turn,
    'river' => PokerStreet.river,
    'complete' => PokerStreet.complete,
    _ => PokerStreet.preflop,
  };
}

enum PokerSeatState {
  seated,
  sittingOut,
  standing;

  static PokerSeatState parse(String? raw) => switch (raw) {
    'sitting_out' => PokerSeatState.sittingOut,
    'standing' => PokerSeatState.standing,
    _ => PokerSeatState.seated,
  };
}

/// What the server says this player may do, and the bounds it will accept.
///
/// The client disables what is not offered — but the server re-checks everything, so a
/// button that should not be there costs a rejected request, never a bad action.
class PokerLegalActions {
  const PokerLegalActions({
    required this.canFold,
    required this.canCheck,
    required this.canCall,
    required this.callAmount,
    required this.canBet,
    required this.canRaise,
    required this.minRaiseTo,
    required this.maxRaiseTo,
    this.raiseBlockedReason,
  });

  final bool canFold;
  final bool canCheck;
  final bool canCall;
  final int callAmount;
  final bool canBet;
  final bool canRaise;
  final int minRaiseTo;
  final int maxRaiseTo;

  /// Why raising is unavailable for a rule reason rather than a lack of chips.
  final String? raiseBlockedReason;

  factory PokerLegalActions.fromJson(Map<String, dynamic> json) => PokerLegalActions(
    canFold: json['canFold'] as bool? ?? false,
    canCheck: json['canCheck'] as bool? ?? false,
    canCall: json['canCall'] as bool? ?? false,
    callAmount: json['callAmount'] as int? ?? 0,
    canBet: json['canBet'] as bool? ?? false,
    canRaise: json['canRaise'] as bool? ?? false,
    minRaiseTo: json['minRaiseTo'] as int? ?? 0,
    maxRaiseTo: json['maxRaiseTo'] as int? ?? 0,
    raiseBlockedReason: json['raiseBlockedReason'] as String?,
  );
}

class PokerHandSeat {
  const PokerHandSeat({
    required this.userId,
    required this.seat,
    required this.stack,
    required this.committed,
    required this.streetBet,
    required this.folded,
    required this.allIn,
    this.cards,
  });

  final String userId;
  final int seat;
  final Money stack;
  final Money committed;
  final Money streetBet;
  final bool folded;
  final bool allIn;

  /// Null unless this hand was shown down. Nobody else's cards ever arrive here.
  final List<String>? cards;

  factory PokerHandSeat.fromJson(Map<String, dynamic> json, String currency) => PokerHandSeat(
    userId: json['userId'] as String? ?? '',
    seat: json['seat'] as int? ?? 0,
    stack: Money(amount: json['stack'] as int? ?? 0, currency: currency),
    committed: Money(amount: json['committed'] as int? ?? 0, currency: currency),
    streetBet: Money(amount: json['streetBet'] as int? ?? 0, currency: currency),
    folded: json['folded'] as bool? ?? false,
    allIn: json['allIn'] as bool? ?? false,
    cards: (json['cards'] as List<dynamic>?)?.cast<String>(),
  );
}

/// The caller's own seat — the only place their hole cards appear.
class PokerOwnSeat {
  const PokerOwnSeat({
    required this.seat,
    required this.cards,
    required this.stack,
    required this.folded,
    required this.allIn,
    required this.timebankMs,
    this.legal,
  });

  final int seat;
  final List<String> cards;
  final Money stack;
  final bool folded;
  final bool allIn;
  final int timebankMs;

  /// Present only while it is this player's turn.
  final PokerLegalActions? legal;

  factory PokerOwnSeat.fromJson(Map<String, dynamic> json, String currency) => PokerOwnSeat(
    seat: json['seat'] as int? ?? 0,
    cards: (json['cards'] as List<dynamic>? ?? []).cast<String>(),
    stack: Money(amount: json['stack'] as int? ?? 0, currency: currency),
    folded: json['folded'] as bool? ?? false,
    allIn: json['allIn'] as bool? ?? false,
    timebankMs: json['timebankMs'] as int? ?? 0,
    legal: json['legal'] == null
        ? null
        : PokerLegalActions.fromJson(json['legal'] as Map<String, dynamic>),
  );
}

class PokerHand {
  const PokerHand({
    required this.street,
    required this.board,
    required this.pot,
    required this.currentBet,
    required this.seats,
    this.buttonSeat,
    this.toAct,
    this.deadlineAt,
    this.you,
    this.shown = const [],
  });

  final PokerStreet street;
  final List<String> board;
  final Money pot;
  final Money currentBet;
  final List<PokerHandSeat> seats;
  final int? buttonSeat;

  /// Whose turn it is, or null between decisions.
  final String? toAct;

  /// Advisory for a countdown; the server owns the deadline (rule 2).
  final DateTime? deadlineAt;

  final PokerOwnSeat? you;

  /// Hands shown at showdown. A mucked hand never appears.
  final List<({String userId, List<String> cards})> shown;

  bool get isOver => street == PokerStreet.complete;

  factory PokerHand.fromJson(Map<String, dynamic> json, String currency) {
    final result = json['result'] as Map<String, dynamic>?;
    return PokerHand(
      street: PokerStreet.parse(json['street'] as String?),
      board: (json['board'] as List<dynamic>? ?? []).cast<String>(),
      pot: Money(amount: json['pot'] as int? ?? 0, currency: currency),
      currentBet: Money(amount: json['currentBet'] as int? ?? 0, currency: currency),
      seats: (json['seats'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((seat) => PokerHandSeat.fromJson(seat, currency))
          .toList(),
      buttonSeat: json['buttonSeat'] as int?,
      toAct: json['toAct'] as String?,
      deadlineAt: json['deadlineAt'] is int
          ? DateTime.fromMillisecondsSinceEpoch(json['deadlineAt'] as int)
          : null,
      you: json['you'] == null
          ? null
          : PokerOwnSeat.fromJson(json['you'] as Map<String, dynamic>, currency),
      shown: ((result?['shown'] as List<dynamic>?) ?? [])
          .whereType<Map<String, dynamic>>()
          .map((entry) => (
                userId: entry['userId'] as String? ?? '',
                cards: (entry['cards'] as List<dynamic>? ?? []).cast<String>(),
              ))
          .toList(),
    );
  }
}

class PokerTableSeat {
  const PokerTableSeat({
    required this.seatNo,
    required this.userId,
    required this.stack,
    required this.state,
  });

  final int seatNo;
  final String userId;
  final Money stack;
  final PokerSeatState state;

  factory PokerTableSeat.fromJson(Map<String, dynamic> json, String currency) => PokerTableSeat(
    seatNo: json['seatNo'] as int? ?? 0,
    userId: json['userId'] as String? ?? '',
    stack: Money(amount: json['stack'] as int? ?? 0, currency: currency),
    state: PokerSeatState.parse(json['state'] as String?),
  );
}

class PokerTable {
  const PokerTable({
    required this.tableId,
    required this.name,
    required this.seatCount,
    required this.currency,
    required this.smallBlind,
    required this.bigBlind,
    required this.minBuyIn,
    required this.maxBuyIn,
    required this.room,
    required this.seats,
    this.hand,
    this.matchId,
  });

  final String tableId;
  final String name;
  final int seatCount;
  final String currency;
  final Money smallBlind;
  final Money bigBlind;
  final Money minBuyIn;
  final Money maxBuyIn;
  final String room;
  final List<PokerTableSeat> seats;
  final PokerHand? hand;
  final String? matchId;

  bool get hasOpenSeat => seats.length < seatCount;

  /// The realtime room carrying this table. Mirrors `pokerTableRoom` in contracts.
  static String roomFor(String tableId) => 'round:table-$tableId';

  PokerTableSeat? seatOf(String? userId) {
    if (userId == null) return null;
    for (final seat in seats) {
      if (seat.userId == userId) return seat;
    }
    return null;
  }

  factory PokerTable.fromJson(Map<String, dynamic> json) {
    final currency = json['currency'] as String? ?? Money.testCurrency;
    final blinds = (json['blinds'] as Map<String, dynamic>?) ?? const {};
    final buyIn = (json['buyIn'] as Map<String, dynamic>?) ?? const {};

    return PokerTable(
      tableId: json['tableId'] as String? ?? '',
      name: json['name'] as String? ?? 'Table',
      seatCount: json['seatCount'] as int? ?? 6,
      currency: currency,
      smallBlind: Money(amount: blinds['sb'] as int? ?? 0, currency: currency),
      bigBlind: Money(amount: blinds['bb'] as int? ?? 0, currency: currency),
      minBuyIn: Money(amount: buyIn['min'] as int? ?? 0, currency: currency),
      maxBuyIn: Money(amount: buyIn['max'] as int? ?? 0, currency: currency),
      room: json['room'] as String? ?? 'round:table-${json['tableId'] ?? ''}',
      seats: (json['seats'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((seat) => PokerTableSeat.fromJson(seat, currency))
          .toList(),
      hand: json['hand'] == null
          ? null
          : PokerHand.fromJson(json['hand'] as Map<String, dynamic>, currency),
      matchId: json['matchId'] as String?,
    );
  }
}

class PokerTableSummary {
  const PokerTableSummary({
    required this.tableId,
    required this.name,
    required this.smallBlind,
    required this.bigBlind,
    required this.seatCount,
    required this.seated,
  });

  final String tableId;
  final String name;
  final Money smallBlind;
  final Money bigBlind;
  final int seatCount;
  final int seated;

  factory PokerTableSummary.fromJson(Map<String, dynamic> json) {
    final currency = json['currency'] as String? ?? Money.testCurrency;
    final blinds = (json['blinds'] as Map<String, dynamic>?) ?? const {};
    return PokerTableSummary(
      tableId: json['tableId'] as String? ?? '',
      name: json['name'] as String? ?? 'Table',
      smallBlind: Money(amount: blinds['sb'] as int? ?? 0, currency: currency),
      bigBlind: Money(amount: blinds['bb'] as int? ?? 0, currency: currency),
      seatCount: json['seatCount'] as int? ?? 6,
      seated: json['seated'] as int? ?? 0,
    );
  }
}
