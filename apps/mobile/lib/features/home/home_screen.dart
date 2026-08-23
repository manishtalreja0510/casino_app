import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../wallet/wallet_providers.dart';

/// Placeholder home screen.
///
/// Exists to prove the chassis end to end — config, router, API client, connection state,
/// tokens — not to be a product screen. The real lobby arrives with P7. Note what it does
/// NOT do: no logic, no styling literals, no direct networking (rules 21, 25).
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final config = ref.watch(appConfigProvider);
    final connection = ref.watch(connectionStateProvider);
    final health = ref.watch(serverReachabilityProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(config.appName),
        actions: [
          if (config.environmentBadge != null)
            Padding(
              padding: EdgeInsets.only(right: t.space.md),
              child: Center(
                child: Text(
                  config.environmentBadge!,
                  style: t.text.label.copyWith(color: t.colors.warning),
                ),
              ),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (connection != AppConnectionState.online)
              Padding(
                padding: EdgeInsets.all(t.space.md),
                child: AppBanner(
                  tone: AppBannerTone.warning,
                  icon: Icons.cloud_off,
                  message: connection == AppConnectionState.offline
                      ? 'You are offline. Reconnecting automatically.'
                      : 'Cannot reach the server. Retrying.',
                  action: AppButton(
                    label: 'Retry',
                    variant: AppButtonVariant.ghost,
                    onPressed: () => ref.invalidate(serverReachabilityProvider),
                  ),
                ),
              ),
            Expanded(
              child: Padding(
                padding: EdgeInsets.all(t.space.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Platform', style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
                          SizedBox(height: t.space.sm),
                          health.when(
                            loading: () => const AppLoadingState(message: 'Checking server…'),
                            error: (_, __) => Text(
                              'Server unreachable',
                              style: t.text.body.copyWith(color: t.colors.danger),
                            ),
                            data: (status) => Text(
                              'Server: ${status.name} · ${config.flavor.name}',
                              style: t.text.body.copyWith(color: t.colors.textSecondary),
                            ),
                          ),
                        ],
                      ),
                    ),
                    SizedBox(height: t.space.md),
                    // Test-currency balance is server-owned; this is a placeholder value
                    // formatted from integer minor units, never computed here (rule 4).
                    AppCard(
                      onTap: () => context.push(AppRoutes.wallet),
                      child: Consumer(
                        builder: (context, ref, _) {
                          final balance = ref.watch(balanceProvider);
                          return balance.when(
                            loading: () => const AppLoadingState(),
                            error: (_, __) => BalanceDisplay(
                              label: 'Balance',
                              formattedAmount: const Money(
                                amount: 0,
                                currency: Money.testCurrency,
                              ).format(),
                              large: true,
                            ),
                            data: (money) => BalanceDisplay(
                              label: 'Balance',
                              formattedAmount: money.format(),
                              large: true,
                            ),
                          );
                        },
                      ),
                    ),
                    SizedBox(height: t.space.md),
                    AppButton(
                      label: 'Play',
                      expand: true,
                      icon: Icons.sports_esports,
                      onPressed: () => context.push(AppRoutes.lobby),
                    ),
                    SizedBox(height: t.space.md),
                    // Reachable from the home screen rather than buried in a settings
                    // menu: a control somebody has to hunt for when they are losing is a
                    // control they will not use.
                    AppButton(
                      label: 'Playing safely',
                      variant: AppButtonVariant.secondary,
                      expand: true,
                      icon: Icons.shield_outlined,
                      onPressed: () => context.push(AppRoutes.responsibleGaming),
                    ),
                    const Spacer(),
                    if (!config.flavor.isProduction)
                      AppButton(
                        label: 'Component gallery',
                        variant: AppButtonVariant.secondary,
                        expand: true,
                        onPressed: () => context.push(AppRoutes.gallery),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
