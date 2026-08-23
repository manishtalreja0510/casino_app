import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ui_kit/ui_kit.dart';

/// Golden tests pin the placeholder theme.
///
/// Their job now: catch an accidental visual change (someone tweaking a token by hand).
/// Their job in P19: make the designer's restyle show up as a deliberate, reviewable
/// golden update rather than an invisible drift.
void main() {
  Widget harness(Widget child) => MaterialApp(
        theme: AppTheme.placeholderDark(),
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: Center(
            child: Padding(padding: const EdgeInsets.all(16), child: child),
          ),
        ),
      );

  testWidgets('buttons', (tester) async {
    await tester.pumpWidget(harness(
      Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppButton(label: 'Primary', onPressed: () {}),
          const SizedBox(height: 8),
          AppButton(label: 'Secondary', variant: AppButtonVariant.secondary, onPressed: () {}),
          const SizedBox(height: 8),
          AppButton(label: 'Danger', variant: AppButtonVariant.danger, onPressed: () {}),
          const SizedBox(height: 8),
          const AppButton(label: 'Disabled'),
        ],
      ),
    ),);
    await expectLater(find.byType(Column).first, matchesGoldenFile('goldens/buttons.png'));
  });

  testWidgets('money display', (tester) async {
    await tester.pumpWidget(harness(
      const Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BalanceDisplay(label: 'Balance', formattedAmount: '12,345.67 TST', large: true),
          SizedBox(height: 8),
          BalanceDisplay(formattedAmount: '+250.00 TST', tone: MoneyTone.positive),
          SizedBox(height: 8),
          BalanceDisplay(formattedAmount: '-50.00 TST', tone: MoneyTone.negative),
        ],
      ),
    ),);
    await expectLater(find.byType(Column).first, matchesGoldenFile('goldens/money.png'));
  });

  testWidgets('banners', (tester) async {
    await tester.pumpWidget(harness(
      const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppBanner(message: 'Informational', icon: Icons.info_outline),
          SizedBox(height: 8),
          AppBanner(message: 'Offline. Reconnecting.', tone: AppBannerTone.warning, icon: Icons.cloud_off),
          SizedBox(height: 8),
          AppBanner(message: 'Failed', tone: AppBannerTone.danger, icon: Icons.error_outline),
        ],
      ),
    ),);
    await expectLater(find.byType(Column).first, matchesGoldenFile('goldens/banners.png'));
  });
}
