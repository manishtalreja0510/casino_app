import 'package:flutter/material.dart';

import 'tokens/colors.dart';
import 'tokens/motion.dart';
import 'tokens/spacing.dart';
import 'tokens/typography.dart';

/// Builds the app theme from tokens.
///
/// P19 replaces token *values* here; it does not touch screens or component call sites
/// (ADR-019). Everything a widget needs comes through `context.tokens`.
class AppTheme {
  const AppTheme._();

  /// The deliberately plain dark placeholder theme.
  static ThemeData placeholderDark() {
    const colors = AppColors.placeholderDark;
    const typography = AppTypography.placeholder;
    const spacing = AppSpacing.placeholder;
    const motion = AppMotion.placeholder;

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: colors.background,
      canvasColor: colors.background,
      colorScheme: const ColorScheme.dark(
        primary: Color(0xFF4F8DF7),
        onPrimary: Color(0xFF0B1220),
        surface: Color(0xFF1A1D21),
        onSurface: Color(0xFFE9ECF1),
        error: Color(0xFFE2564D),
      ),
      // Registered as extensions so components read semantic roles, never Material's
      // generic slots — Material's vocabulary is not our design system's.
      extensions: const <ThemeExtension<dynamic>>[colors, typography, spacing, motion],
      textTheme: TextTheme(
        displayLarge: typography.display.copyWith(color: colors.textPrimary),
        titleLarge: typography.titleLarge.copyWith(color: colors.textPrimary),
        titleMedium: typography.titleMedium.copyWith(color: colors.textPrimary),
        bodyMedium: typography.body.copyWith(color: colors.textPrimary),
        bodySmall: typography.bodySmall.copyWith(color: colors.textSecondary),
        labelMedium: typography.label.copyWith(color: colors.textSecondary),
      ),
    );
  }
}

/// Token access. `context.tokens.colors.danger` — never a raw value in a widget.
extension AppTokens on BuildContext {
  AppTokenSet get tokens => AppTokenSet(
        colors: Theme.of(this).extension<AppColors>() ?? AppColors.placeholderDark,
        text: Theme.of(this).extension<AppTypography>() ?? AppTypography.placeholder,
        space: Theme.of(this).extension<AppSpacing>() ?? AppSpacing.placeholder,
        motion: Theme.of(this).extension<AppMotion>() ?? AppMotion.placeholder,
      );
}

@immutable
class AppTokenSet {
  const AppTokenSet({
    required this.colors,
    required this.text,
    required this.space,
    required this.motion,
  });

  final AppColors colors;
  final AppTypography text;
  final AppSpacing space;
  final AppMotion motion;
}
