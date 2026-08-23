import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:ui_kit/ui_kit.dart';

/// Component gallery — every `ui_kit` component in every state.
///
/// Two audiences: developers (what exists, so nobody invents a one-off styled widget),
/// and the designer in P19 (the complete surface to restyle). If a component is not
/// here, it is not finished.
class GalleryScreen extends StatelessWidget {
  const GalleryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Scaffold(
      appBar: AppBar(title: const Text('Component gallery')),
      body: ListView(
        padding: EdgeInsets.all(t.space.md),
        children: [
          _Section(
            title: 'Buttons',
            child: Wrap(
              spacing: t.space.sm,
              runSpacing: t.space.sm,
              children: [
                AppButton(label: 'Primary', onPressed: () {}),
                AppButton(label: 'Secondary', variant: AppButtonVariant.secondary, onPressed: () {}),
                AppButton(label: 'Danger', variant: AppButtonVariant.danger, onPressed: () {}),
                AppButton(label: 'Ghost', variant: AppButtonVariant.ghost, onPressed: () {}),
                const AppButton(label: 'Disabled'),
                AppButton(label: 'Loading', loading: true, onPressed: () {}),
                AppButton(label: 'With icon', icon: Icons.account_balance_wallet, onPressed: () {}),
              ],
            ),
          ),
          _Section(
            title: 'Money',
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                BalanceDisplay(
                  label: 'Balance',
                  formattedAmount: const Money(amount: 1234567, currency: Money.testCurrency).format(),
                ),
                BalanceDisplay(
                  label: 'Won',
                  tone: MoneyTone.positive,
                  formattedAmount: '+${const Money(amount: 25000, currency: Money.testCurrency).format()}',
                ),
                BalanceDisplay(
                  label: 'Lost',
                  tone: MoneyTone.negative,
                  formattedAmount: const Money(amount: -5000, currency: Money.testCurrency).format(),
                ),
              ],
            ),
          ),
          _Section(
            title: 'Inputs',
            child: Column(
              children: [
                const AppInput(label: 'Email', hint: 'you@example.com'),
                SizedBox(height: t.space.md),
                const AppInput(label: 'Password', hint: '••••••••', obscure: true),
                SizedBox(height: t.space.md),
                const AppInput(label: 'Amount', errorText: 'Enter an amount greater than zero'),
                SizedBox(height: t.space.md),
                const AppInput(label: 'Disabled', enabled: false, hint: 'Not editable'),
              ],
            ),
          ),
          _Section(
            title: 'Banners',
            child: Column(
              children: [
                const AppBanner(message: 'Informational message', icon: Icons.info_outline),
                SizedBox(height: t.space.sm),
                const AppBanner(message: 'Action succeeded', tone: AppBannerTone.success, icon: Icons.check),
                SizedBox(height: t.space.sm),
                const AppBanner(
                  message: 'You are offline. Reconnecting automatically.',
                  tone: AppBannerTone.warning,
                  icon: Icons.cloud_off,
                ),
                SizedBox(height: t.space.sm),
                const AppBanner(message: 'Something went wrong', tone: AppBannerTone.danger, icon: Icons.error_outline),
              ],
            ),
          ),
          _Section(
            title: 'Timers (cosmetic — the server owns every deadline)',
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: const [
                CountdownRing(remaining: Duration(seconds: 12), total: Duration(seconds: 15)),
                CountdownRing(remaining: Duration(seconds: 6), total: Duration(seconds: 15)),
                CountdownRing(remaining: Duration(seconds: 2), total: Duration(seconds: 15)),
              ],
            ),
          ),
          _Section(
            title: 'States',
            child: SizedBox(
              height: 480,
              child: Column(
                children: [
                  const Expanded(child: AppLoadingState(message: 'Loading…')),
                  Expanded(
                    child: AppEmptyState(
                      title: 'No games yet',
                      message: 'Games appear here once you join a table.',
                      actionLabel: 'Browse lobby',
                      onAction: () {},
                    ),
                  ),
                  Expanded(
                    child: AppErrorState(
                      title: 'Something went wrong',
                      message: 'Please try again.',
                      supportReference: '018f2b1c-0000-7000-8000-000000000000',
                      onRetry: () {},
                    ),
                  ),
                ],
              ),
            ),
          ),
          _Section(
            title: 'Animation wrappers (placeholder implementations)',
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                CardDealAnimation(
                  child: AppCard(raised: true, child: Text('Dealt', style: t.text.body)),
                ),
                WinCelebration(
                  child: AppCard(raised: true, child: Text('Winner', style: t.text.body)),
                ),
              ],
            ),
          ),
          _Section(
            title: 'Dialog',
            child: AppButton(
              label: 'Open dialog',
              variant: AppButtonVariant.secondary,
              onPressed: () => showDialog<void>(
                context: context,
                builder: (context) => AppDialog(
                  title: 'Leave the table?',
                  message: 'Your seat will be released and your remaining stack returned.',
                  actions: [
                    AppButton(
                      label: 'Stay',
                      variant: AppButtonVariant.ghost,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                    AppButton(
                      label: 'Leave',
                      variant: AppButtonVariant.danger,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: EdgeInsets.only(bottom: t.space.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: t.text.label.copyWith(color: t.colors.textSecondary)),
          SizedBox(height: t.space.sm),
          child,
        ],
      ),
    );
  }
}
