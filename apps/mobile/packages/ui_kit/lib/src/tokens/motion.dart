import 'package:flutter/material.dart';

/// Motion tokens.
///
/// Animation wrappers take their durations and curves from here, so P19 can retime the
/// whole app — or swap a placeholder animation for a Rive one — without call sites
/// changing (`asset-animation-pipeline.md`).
@immutable
class AppMotion extends ThemeExtension<AppMotion> {
  const AppMotion({
    required this.instant,
    required this.quick,
    required this.standard,
    required this.slow,
    required this.celebration,
    required this.enter,
    required this.exit,
    required this.emphasis,
  });

  final Duration instant;
  final Duration quick;
  final Duration standard;
  final Duration slow;

  /// Win celebrations: long enough to register, short enough not to delay the next round.
  final Duration celebration;

  final Curve enter;
  final Curve exit;
  final Curve emphasis;

  static const AppMotion placeholder = AppMotion(
    instant: Duration(milliseconds: 80),
    quick: Duration(milliseconds: 150),
    standard: Duration(milliseconds: 250),
    slow: Duration(milliseconds: 400),
    celebration: Duration(milliseconds: 1200),
    enter: Curves.easeOutCubic,
    exit: Curves.easeInCubic,
    emphasis: Curves.easeOutBack,
  );

  @override
  AppMotion copyWith({
    Duration? instant,
    Duration? quick,
    Duration? standard,
    Duration? slow,
    Duration? celebration,
    Curve? enter,
    Curve? exit,
    Curve? emphasis,
  }) {
    return AppMotion(
      instant: instant ?? this.instant,
      quick: quick ?? this.quick,
      standard: standard ?? this.standard,
      slow: slow ?? this.slow,
      celebration: celebration ?? this.celebration,
      enter: enter ?? this.enter,
      exit: exit ?? this.exit,
      emphasis: emphasis ?? this.emphasis,
    );
  }

  @override
  AppMotion lerp(ThemeExtension<AppMotion>? other, double t) => other is AppMotion && t >= 0.5 ? other : this;
}
