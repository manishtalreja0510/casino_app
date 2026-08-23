/// Lobby payloads mirroring `/lobby` (P7).
library;

import 'money.dart';

class StakeTier {
  const StakeTier({
    required this.id,
    required this.name,
    required this.stake,
    required this.queueDepth,
  });

  final String id;
  final String name;

  /// Buy-in, integer minor units (rule 4).
  final Money stake;

  /// Players currently waiting. Approximate — stale entries are pruned lazily.
  final int queueDepth;

  bool get isFree => stake.amount == 0;

  factory StakeTier.fromJson(Map<String, dynamic> json) => StakeTier(
    id: json['id'] as String,
    name: json['name'] as String,
    stake: Money(
      amount: json['stake'] as int,
      currency: json['currency'] as String? ?? Money.testCurrency,
    ),
    queueDepth: json['queueDepth'] as int? ?? 0,
  );
}

class LobbyGame {
  const LobbyGame({
    required this.gameCode,
    required this.name,
    required this.enabled,
    required this.activeMatches,
    required this.tiers,
  });

  final String gameCode;
  final String name;

  /// False when the per-game kill-switch is off. Shown but not joinable — a game that
  /// vanished with no explanation is worse than one visibly unavailable.
  final bool enabled;

  final int activeMatches;
  final List<StakeTier> tiers;

  factory LobbyGame.fromJson(Map<String, dynamic> json) => LobbyGame(
    gameCode: json['gameCode'] as String,
    name: json['name'] as String,
    enabled: json['enabled'] as bool? ?? false,
    activeMatches: json['activeMatches'] as int? ?? 0,
    tiers: (json['tiers'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(StakeTier.fromJson)
        .toList(),
  );
}

class QueueStatus {
  const QueueStatus({required this.queued, required this.depth, this.matchId});

  final bool queued;
  final int depth;

  /// Set when joining formed a match immediately.
  final String? matchId;

  factory QueueStatus.fromJson(Map<String, dynamic> json) => QueueStatus(
    queued: json['queued'] as bool? ?? false,
    depth: json['depth'] as int? ?? 0,
    matchId: json['matchId'] as String?,
  );
}
