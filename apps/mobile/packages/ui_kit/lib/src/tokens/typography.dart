import 'package:flutter/material.dart';

/// Type scale. Roles are named by purpose, not size, so the designer can retune the
/// scale without every call site becoming a lie (`titleLarge` staying small, say).
@immutable
class AppTypography extends ThemeExtension<AppTypography> {
  const AppTypography({
    required this.display,
    required this.titleLarge,
    required this.titleMedium,
    required this.body,
    required this.bodySmall,
    required this.label,
    required this.mono,
  });

  final TextStyle display;
  final TextStyle titleLarge;
  final TextStyle titleMedium;
  final TextStyle body;
  final TextStyle bodySmall;
  final TextStyle label;

  /// Tabular figures for money and timers: digits must not shift width as they change,
  /// or a counting balance visibly jitters.
  final TextStyle mono;

  static const AppTypography placeholder = AppTypography(
    display: TextStyle(fontSize: 32, fontWeight: FontWeight.w700, height: 1.2),
    titleLarge: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.25),
    titleMedium: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, height: 1.3),
    body: TextStyle(fontSize: 15, fontWeight: FontWeight.w400, height: 1.45),
    bodySmall: TextStyle(fontSize: 13, fontWeight: FontWeight.w400, height: 1.4),
    label: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, height: 1.2, letterSpacing: 0.4),
    mono: TextStyle(
      fontSize: 15,
      fontWeight: FontWeight.w600,
      height: 1.3,
      fontFeatures: [FontFeature.tabularFigures()],
    ),
  );

  @override
  AppTypography copyWith({
    TextStyle? display,
    TextStyle? titleLarge,
    TextStyle? titleMedium,
    TextStyle? body,
    TextStyle? bodySmall,
    TextStyle? label,
    TextStyle? mono,
  }) {
    return AppTypography(
      display: display ?? this.display,
      titleLarge: titleLarge ?? this.titleLarge,
      titleMedium: titleMedium ?? this.titleMedium,
      body: body ?? this.body,
      bodySmall: bodySmall ?? this.bodySmall,
      label: label ?? this.label,
      mono: mono ?? this.mono,
    );
  }

  @override
  AppTypography lerp(ThemeExtension<AppTypography>? other, double t) {
    if (other is! AppTypography) return this;
    return AppTypography(
      display: TextStyle.lerp(display, other.display, t)!,
      titleLarge: TextStyle.lerp(titleLarge, other.titleLarge, t)!,
      titleMedium: TextStyle.lerp(titleMedium, other.titleMedium, t)!,
      body: TextStyle.lerp(body, other.body, t)!,
      bodySmall: TextStyle.lerp(bodySmall, other.bodySmall, t)!,
      label: TextStyle.lerp(label, other.label, t)!,
      mono: TextStyle.lerp(mono, other.mono, t)!,
    );
  }
}
