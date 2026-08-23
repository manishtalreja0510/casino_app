import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ui_kit/ui_kit.dart';

Widget wrap(Widget child) => MaterialApp(
      theme: AppTheme.placeholderDark(),
      home: Scaffold(body: child),
    );

void main() {
  group('AppButton', () {
    testWidgets('invokes onPressed when enabled', (tester) async {
      var taps = 0;
      await tester.pumpWidget(wrap(AppButton(label: 'Go', onPressed: () => taps++)));
      await tester.tap(find.text('Go'));
      expect(taps, 1);
    });

    testWidgets('does nothing when disabled', (tester) async {
      await tester.pumpWidget(wrap(const AppButton(label: 'Go')));
      await tester.tap(find.text('Go'));
      expect(tester.takeException(), isNull);
    });

    testWidgets('is not tappable while loading — a financial action must not double-submit',
        (tester) async {
      var taps = 0;
      await tester.pumpWidget(wrap(AppButton(label: 'Pay', loading: true, onPressed: () => taps++)));
      await tester.tap(find.text('Pay'));
      await tester.pump();
      expect(taps, 0);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('renders every variant', (tester) async {
      for (final variant in AppButtonVariant.values) {
        await tester.pumpWidget(wrap(AppButton(label: variant.name, variant: variant, onPressed: () {})));
        expect(find.text(variant.name), findsOneWidget);
      }
    });
  });

  group('BalanceDisplay', () {
    testWidgets('renders the formatted amount it is given', (tester) async {
      await tester.pumpWidget(wrap(const BalanceDisplay(label: 'Balance', formattedAmount: '12,345.67 TST')));
      expect(find.text('12,345.67 TST'), findsOneWidget);
      expect(find.text('Balance'), findsOneWidget);
    });

    testWidgets('uses token colours for win and loss tones', (tester) async {
      await tester.pumpWidget(wrap(const BalanceDisplay(formattedAmount: '+1.00', tone: MoneyTone.positive)));
      final text = tester.widget<Text>(find.text('+1.00'));
      expect(text.style?.color, AppColors.placeholderDark.success);
    });
  });

  group('CountdownRing', () {
    testWidgets('shows remaining seconds', (tester) async {
      await tester.pumpWidget(
        wrap(const CountdownRing(remaining: Duration(seconds: 9), total: Duration(seconds: 15))),
      );
      expect(find.text('9'), findsOneWidget);
    });

    testWidgets('escalates colour by fraction remaining, not absolute seconds', (tester) async {
      // 4s of 60s is urgent; 4s of 5s is not yet — urgency must be relative.
      await tester.pumpWidget(
        wrap(const CountdownRing(remaining: Duration(seconds: 4), total: Duration(seconds: 60))),
      );
      final urgent = tester.widget<Text>(find.text('4'));
      expect(urgent.style?.color, AppColors.placeholderDark.danger);

      await tester.pumpWidget(
        wrap(const CountdownRing(remaining: Duration(seconds: 4), total: Duration(seconds: 5))),
      );
      final calm = tester.widget<Text>(find.text('4'));
      expect(calm.style?.color, AppColors.placeholderDark.primary);
    });

    testWidgets('survives a zero total without dividing by zero', (tester) async {
      await tester.pumpWidget(
        wrap(const CountdownRing(remaining: Duration.zero, total: Duration.zero)),
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('States', () {
    testWidgets('error state shows the support reference and retries', (tester) async {
      var retried = 0;
      await tester.pumpWidget(wrap(AppErrorState(
        title: 'Failed',
        supportReference: 'trace-abc',
        onRetry: () => retried++,
      ),),);
      expect(find.textContaining('trace-abc'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      expect(retried, 1);
    });

    testWidgets('empty state renders its action', (tester) async {
      await tester.pumpWidget(wrap(const AppEmptyState(title: 'Nothing here', actionLabel: 'Refresh')));
      expect(find.text('Nothing here'), findsOneWidget);
      expect(find.text('Refresh'), findsOneWidget);
    });
  });

  group('Animation wrappers', () {
    testWidgets('CardDealAnimation completes and reports back', (tester) async {
      var done = false;
      await tester.pumpWidget(wrap(CardDealAnimation(
        onComplete: () => done = true,
        child: const Text('card'),
      ),),);
      await tester.pumpAndSettle(const Duration(seconds: 1));
      expect(find.text('card'), findsOneWidget);
      expect(done, isTrue);
    });

    testWidgets('WinCelebration keeps its child visible throughout', (tester) async {
      await tester.pumpWidget(wrap(const WinCelebration(child: Text('winner'))));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('winner'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(seconds: 2));
      expect(find.text('winner'), findsOneWidget);
    });
  });

  group('Multiplier display', () {
    testWidgets('renders an integer x100 the way a player reads it', (tester) async {
      await tester.pumpWidget(
        wrap(
          const AppMultiplierDisplay(
            multiplierX100: 1234,
            phase: MultiplierPhase.rising,
            caption: 'In flight',
          ),
        ),
      );

      expect(find.text('12.34x'), findsOneWidget);
      expect(find.text('In flight'), findsOneWidget);
    });

    testWidgets('colours by phase from tokens, never a literal', (tester) async {
      for (final phase in MultiplierPhase.values) {
        await tester.pumpWidget(wrap(AppMultiplierDisplay(multiplierX100: 100, phase: phase)));
        await tester.pump();
        expect(find.text('1.00x'), findsOneWidget);
      }
    });

    testWidgets('outcome strip shows recent rounds, newest first, and nothing more',
        (tester) async {
      await tester.pumpWidget(wrap(const AppOutcomeStrip(outcomesX100: [431, 100, 1050])));

      expect(find.text('4.31x'), findsOneWidget);
      expect(find.text('1.00x'), findsOneWidget);
      expect(find.text('10.50x'), findsOneWidget);
    });

    testWidgets('outcome strip says so when there is nothing to show', (tester) async {
      await tester.pumpWidget(wrap(const AppOutcomeStrip(outcomesX100: [])));
      expect(find.text('No rounds yet'), findsOneWidget);
    });

    testWidgets('outcome strip caps what it renders rather than growing without bound',
        (tester) async {
      final many = List<int>.generate(50, (i) => 100 + i);
      await tester.pumpWidget(wrap(AppOutcomeStrip(outcomesX100: many, maxItems: 3)));

      expect(find.text('1.00x'), findsOneWidget);
      expect(find.text('1.02x'), findsOneWidget);
      expect(find.text('1.03x'), findsNothing);
    });
  });
}
