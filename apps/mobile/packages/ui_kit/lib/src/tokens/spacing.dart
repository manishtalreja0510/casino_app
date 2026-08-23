import 'package:flutter/material.dart';

/// Spacing, radius and border-width scale.
///
/// A fixed scale rather than free numbers: it keeps rhythm consistent and gives the
/// designer one place to retune density (rule 25).
@immutable
class AppSpacing extends ThemeExtension<AppSpacing> {
  const AppSpacing({
    required this.xs,
    required this.sm,
    required this.md,
    required this.lg,
    required this.xl,
    required this.xxl,
    required this.radiusSm,
    required this.radiusMd,
    required this.radiusLg,
    required this.radiusPill,
    required this.borderWidth,
  });

  final double xs;
  final double sm;
  final double md;
  final double lg;
  final double xl;
  final double xxl;

  final double radiusSm;
  final double radiusMd;
  final double radiusLg;
  final double radiusPill;

  final double borderWidth;

  static const AppSpacing placeholder = AppSpacing(
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
    radiusSm: 6,
    radiusMd: 10,
    radiusLg: 16,
    radiusPill: 999,
    borderWidth: 1,
  );

  @override
  AppSpacing copyWith({
    double? xs,
    double? sm,
    double? md,
    double? lg,
    double? xl,
    double? xxl,
    double? radiusSm,
    double? radiusMd,
    double? radiusLg,
    double? radiusPill,
    double? borderWidth,
  }) {
    return AppSpacing(
      xs: xs ?? this.xs,
      sm: sm ?? this.sm,
      md: md ?? this.md,
      lg: lg ?? this.lg,
      xl: xl ?? this.xl,
      xxl: xxl ?? this.xxl,
      radiusSm: radiusSm ?? this.radiusSm,
      radiusMd: radiusMd ?? this.radiusMd,
      radiusLg: radiusLg ?? this.radiusLg,
      radiusPill: radiusPill ?? this.radiusPill,
      borderWidth: borderWidth ?? this.borderWidth,
    );
  }

  @override
  AppSpacing lerp(ThemeExtension<AppSpacing>? other, double t) {
    if (other is! AppSpacing) return this;
    double l(double a, double b) => a + (b - a) * t;
    return AppSpacing(
      xs: l(xs, other.xs),
      sm: l(sm, other.sm),
      md: l(md, other.md),
      lg: l(lg, other.lg),
      xl: l(xl, other.xl),
      xxl: l(xxl, other.xxl),
      radiusSm: l(radiusSm, other.radiusSm),
      radiusMd: l(radiusMd, other.radiusMd),
      radiusLg: l(radiusLg, other.radiusLg),
      radiusPill: l(radiusPill, other.radiusPill),
      borderWidth: l(borderWidth, other.borderWidth),
    );
  }
}
