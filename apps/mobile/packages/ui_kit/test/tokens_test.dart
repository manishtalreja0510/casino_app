import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ui_kit/ui_kit.dart';

void main() {
  group('token system', () {
    testWidgets('exposes every token set through context.tokens', (tester) async {
      late AppTokenSet tokens;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.placeholderDark(),
        home: Builder(builder: (context) {
          tokens = context.tokens;
          return const SizedBox.shrink();
        },),
      ),);

      expect(tokens.colors, isA<AppColors>());
      expect(tokens.text, isA<AppTypography>());
      expect(tokens.space, isA<AppSpacing>());
      expect(tokens.motion, isA<AppMotion>());
    });

    testWidgets('falls back to the placeholder set when no theme extension is registered',
        (tester) async {
      // A component must render rather than crash if it is used outside the app theme —
      // widget tests and the designer's future previews both do this.
      late AppTokenSet tokens;
      await tester.pumpWidget(MaterialApp(
        home: Builder(builder: (context) {
          tokens = context.tokens;
          return const SizedBox.shrink();
        },),
      ),);
      expect(tokens.colors.primary, AppColors.placeholderDark.primary);
    });

    test('spacing scale is strictly increasing', () {
      const s = AppSpacing.placeholder;
      expect([s.xs, s.sm, s.md, s.lg, s.xl, s.xxl], orderedEquals([4.0, 8.0, 16.0, 24.0, 32.0, 48.0]));
    });

    test('money and timer type uses tabular figures so digits do not jitter', () {
      expect(AppTypography.placeholder.mono.fontFeatures, isNotNull);
      expect(
        AppTypography.placeholder.mono.fontFeatures!.map((f) => f.feature),
        contains('tnum'),
      );
    });

    test('token sets lerp without throwing (theme transitions)', () {
      expect(AppColors.placeholderDark.lerp(AppColors.placeholderDark, 0.5), isA<AppColors>());
      expect(AppSpacing.placeholder.lerp(AppSpacing.placeholder, 0.5), isA<AppSpacing>());
      expect(AppTypography.placeholder.lerp(AppTypography.placeholder, 0.5), isA<AppTypography>());
      expect(AppMotion.placeholder.lerp(AppMotion.placeholder, 0.5), isA<AppMotion>());
    });
  });
}
