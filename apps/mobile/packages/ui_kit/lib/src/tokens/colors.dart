import 'package:flutter/material.dart';

/// Semantic colour roles.
///
/// Screens and components reference **roles**, never raw values, so the designer's
/// palette (P19) lands by changing this file alone (rule 25, ADR-019). A role describes
/// what the colour is *for* — never what it looks like: there is no `blue` here, because
/// a rename would be required the moment the brand is not blue.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.background,
    required this.surface,
    required this.surfaceRaised,
    required this.border,
    required this.primary,
    required this.onPrimary,
    required this.textPrimary,
    required this.textSecondary,
    required this.textDisabled,
    required this.success,
    required this.danger,
    required this.warning,
    required this.info,
    required this.gameFelt,
    required this.overlay,
  });

  final Color background;
  final Color surface;
  final Color surfaceRaised;
  final Color border;
  final Color primary;
  final Color onPrimary;
  final Color textPrimary;
  final Color textSecondary;
  final Color textDisabled;

  /// Outcome roles. `success`/`danger` are also the win/loss roles — money moving in the
  /// player's favour or against it — so a single palette change keeps them consistent.
  final Color success;
  final Color danger;
  final Color warning;
  final Color info;

  /// Table surface for game screens.
  final Color gameFelt;

  /// Scrim behind dialogs and blocking states.
  final Color overlay;

  /// Deliberately plain, unbranded dark placeholder (ADR-019). It is meant to look
  /// finished enough to use and plain enough that nobody mistakes it for the design.
  static const AppColors placeholderDark = AppColors(
    background: Color(0xFF121417),
    surface: Color(0xFF1A1D21),
    surfaceRaised: Color(0xFF23272C),
    border: Color(0xFF313742),
    primary: Color(0xFF4F8DF7),
    onPrimary: Color(0xFF0B1220),
    textPrimary: Color(0xFFE9ECF1),
    textSecondary: Color(0xFFA2ABB8),
    textDisabled: Color(0xFF6B7480),
    success: Color(0xFF3FB27F),
    danger: Color(0xFFE2564D),
    warning: Color(0xFFD8A33C),
    info: Color(0xFF4F8DF7),
    gameFelt: Color(0xFF17342B),
    overlay: Color(0xCC0A0C0F),
  );

  @override
  AppColors copyWith({
    Color? background,
    Color? surface,
    Color? surfaceRaised,
    Color? border,
    Color? primary,
    Color? onPrimary,
    Color? textPrimary,
    Color? textSecondary,
    Color? textDisabled,
    Color? success,
    Color? danger,
    Color? warning,
    Color? info,
    Color? gameFelt,
    Color? overlay,
  }) {
    return AppColors(
      background: background ?? this.background,
      surface: surface ?? this.surface,
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      border: border ?? this.border,
      primary: primary ?? this.primary,
      onPrimary: onPrimary ?? this.onPrimary,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textDisabled: textDisabled ?? this.textDisabled,
      success: success ?? this.success,
      danger: danger ?? this.danger,
      warning: warning ?? this.warning,
      info: info ?? this.info,
      gameFelt: gameFelt ?? this.gameFelt,
      overlay: overlay ?? this.overlay,
    );
  }

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) {
    if (other is! AppColors) return this;
    return AppColors(
      background: Color.lerp(background, other.background, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      border: Color.lerp(border, other.border, t)!,
      primary: Color.lerp(primary, other.primary, t)!,
      onPrimary: Color.lerp(onPrimary, other.onPrimary, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textDisabled: Color.lerp(textDisabled, other.textDisabled, t)!,
      success: Color.lerp(success, other.success, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      info: Color.lerp(info, other.info, t)!,
      gameFelt: Color.lerp(gameFelt, other.gameFelt, t)!,
      overlay: Color.lerp(overlay, other.overlay, t)!,
    );
  }
}
