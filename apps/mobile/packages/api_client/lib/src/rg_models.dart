/// Responsible-gaming payloads mirroring `/rg/*` (P10).
///
/// Every one of these is a **read** of a decision the server already made. Nothing here
/// evaluates a limit, computes what is left, or decides whether play is allowed: the
/// client renders what it is told and asks again afterwards (rules 1, 21). A client that
/// worked out its own remaining allowance would be a client that could be persuaded it had
/// more.
library;

class RgLimit {
  const RgLimit({
    required this.type,
    required this.period,
    required this.amount,
    required this.used,
    this.pendingAmount,
    this.pendingEffectiveAt,
  });

  /// deposit | loss | wager | session_time.
  final String type;

  /// day | week | month.
  final String period;

  /// Integer minor units, or minutes for `session_time`.
  final int amount;

  /// Used so far in the current window, as the server counted it.
  final int used;

  /// A loosening the player asked for that has not taken effect yet.
  final int? pendingAmount;
  final DateTime? pendingEffectiveAt;

  int get remaining => amount - used > 0 ? amount - used : 0;

  bool get hasPendingIncrease => pendingAmount != null;

  factory RgLimit.fromJson(Map<String, dynamic> json) => RgLimit(
    type: json['type'] as String,
    period: json['period'] as String,
    amount: json['amount'] as int,
    used: json['used'] as int,
    pendingAmount: json['pendingAmount'] as int?,
    pendingEffectiveAt: json['pendingEffectiveAt'] == null
        ? null
        : DateTime.parse(json['pendingEffectiveAt'] as String),
  );
}

class RgExclusion {
  const RgExclusion({required this.kind, required this.startsAt, this.endsAt});

  /// cool_off | self_exclusion.
  final String kind;
  final DateTime startsAt;

  /// Null means permanent.
  final DateTime? endsAt;

  bool get isPermanent => endsAt == null;

  factory RgExclusion.fromJson(Map<String, dynamic> json) => RgExclusion(
    kind: json['kind'] as String,
    startsAt: DateTime.parse(json['startsAt'] as String),
    endsAt: json['endsAt'] == null ? null : DateTime.parse(json['endsAt'] as String),
  );
}

class RgRealityCheck {
  const RgRealityCheck({
    required this.intervalMs,
    required this.acknowledged,
    this.lastShownAt,
  });

  final int intervalMs;

  /// Whether the last check the server sent has been acknowledged. When it has not been,
  /// new play pauses after a grace period — the server decides that, not this flag.
  final bool acknowledged;
  final DateTime? lastShownAt;

  factory RgRealityCheck.fromJson(Map<String, dynamic> json) => RgRealityCheck(
    intervalMs: json['intervalMs'] as int,
    acknowledged: json['acknowledged'] as bool,
    lastShownAt: json['lastShownAt'] == null
        ? null
        : DateTime.parse(json['lastShownAt'] as String),
  );
}

class RgEvent {
  const RgEvent({required this.type, required this.at, this.payload = const {}});

  final String type;
  final DateTime at;
  final Map<String, dynamic> payload;

  factory RgEvent.fromJson(Map<String, dynamic> json) => RgEvent(
    type: json['type'] as String,
    at: DateTime.parse(json['at'] as String),
    payload: (json['payload'] as Map<String, dynamic>?) ?? const {},
  );
}

class RgStatus {
  const RgStatus({
    required this.limits,
    required this.realityCheck,
    required this.history,
    required this.events,
    this.exclusion,
  });

  final List<RgLimit> limits;
  final RgRealityCheck realityCheck;

  /// The exclusion in force, if any. While this is set, play and funding are refused by
  /// the server on every path — this field is what to *show*, never what to enforce.
  final RgExclusion? exclusion;

  /// Past and present breaks, newest first.
  final List<RgExclusion> history;

  /// What the player has changed, so the record is theirs to see too.
  final List<RgEvent> events;

  bool get isExcluded => exclusion != null;

  factory RgStatus.fromJson(Map<String, dynamic> json) => RgStatus(
    limits: (json['limits'] as List<dynamic>)
        .map((entry) => RgLimit.fromJson(entry as Map<String, dynamic>))
        .toList(growable: false),
    realityCheck: RgRealityCheck.fromJson(json['realityCheck'] as Map<String, dynamic>),
    exclusion: json['exclusion'] == null
        ? null
        : RgExclusion.fromJson(json['exclusion'] as Map<String, dynamic>),
    history: (json['history'] as List<dynamic>? ?? const [])
        .map((entry) => RgExclusion.fromJson(entry as Map<String, dynamic>))
        .toList(growable: false),
    events: (json['events'] as List<dynamic>? ?? const [])
        .map((entry) => RgEvent.fromJson(entry as Map<String, dynamic>))
        .toList(growable: false),
  );
}
