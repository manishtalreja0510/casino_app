import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import 'wallet_providers.dart';

/// Wallet: balance, history, and (while the interim path is enabled) adding test funds.
class WalletScreen extends ConsumerWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final balance = ref.watch(balanceProvider);
    final transactions = ref.watch(transactionsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(balanceProvider);
          ref.invalidate(transactionsProvider);
          await ref.read(balanceProvider.future);
        },
        child: ListView(
          padding: EdgeInsets.all(t.space.md),
          children: [
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  balance.when(
                    loading: () => const AppLoadingState(),
                    error: (error, _) => AppErrorState(
                      title: 'Could not load your balance',
                      supportReference: error is ApiException ? error.traceId : null,
                      onRetry: () => ref.invalidate(balanceProvider),
                    ),
                    data: (money) => BalanceDisplay(
                      label: 'Balance',
                      formattedAmount: money.format(),
                      large: true,
                    ),
                  ),
                  SizedBox(height: t.space.md),
                  AppButton(
                    label: 'Add test funds',
                    expand: true,
                    onPressed: () => _addFunds(context, ref),
                  ),
                ],
              ),
            ),
            SizedBox(height: t.space.lg),
            Text('Activity', style: t.text.label.copyWith(color: t.colors.textSecondary)),
            SizedBox(height: t.space.sm),
            transactions.when(
              loading: () => const AppLoadingState(),
              error: (error, _) => AppErrorState(
                title: 'Could not load your activity',
                supportReference: error is ApiException ? error.traceId : null,
                onRetry: () => ref.invalidate(transactionsProvider),
              ),
              data: (items) => items.isEmpty
                  ? const AppEmptyState(
                      title: 'No activity yet',
                      message: 'Funding, buy-ins and winnings appear here.',
                    )
                  : Column(
                      children: [
                        for (final item in items) ...[
                          _TransactionTile(transaction: item),
                          SizedBox(height: t.space.sm),
                        ],
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _addFunds(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    // One key per intent, generated before the request and reused on retry, so a timeout
    // cannot lead to a double credit (rule 6).
    final idempotencyKey = 'ui-${DateTime.now().microsecondsSinceEpoch}';

    try {
      await ref.read(apiClientProvider).addFunds(
        amountMinorUnits: 10000,
        idempotencyKey: idempotencyKey,
      );
      ref.invalidate(balanceProvider);
      ref.invalidate(transactionsProvider);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(
        const SnackBar(content: Text('Cannot reach the server. Your balance is unchanged.')),
      );
    }
  }
}

class _TransactionTile extends StatelessWidget {
  const _TransactionTile({required this.transaction});

  final WalletTransaction transaction;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _label(transaction.type),
                  style: t.text.body.copyWith(color: t.colors.textPrimary),
                ),
                Text(
                  _formatTimestamp(transaction.createdAt),
                  style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
                ),
              ],
            ),
          ),
          BalanceDisplay(
            formattedAmount: transaction.amount.format(),
            tone: transaction.isCredit ? MoneyTone.positive : MoneyTone.negative,
          ),
        ],
      ),
    );
  }

  static String _label(String type) => switch (type) {
    'funding' => 'Added funds',
    'buy_in' => 'Buy-in',
    'settlement' => 'Winnings',
    'reversal' => 'Reversal',
    'adjustment' => 'Adjustment',
    _ => type,
  };

  static String _two(int n) => n.toString().padLeft(2, '0');

  static String _formatTimestamp(DateTime value) {
    final local = value.toLocal();
    return '${local.year}-${_two(local.month)}-${_two(local.day)} '
        '${_two(local.hour)}:${_two(local.minute)}';
  }
}
