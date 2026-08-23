import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';

/// Wallet state.
///
/// The balance is **always** whatever the server last said. Nothing here adds, subtracts,
/// or predicts a balance after an action — the client displays money, it never computes it
/// (rules 1, 4). After any operation the provider is invalidated and the server re-asked.
final balanceProvider = FutureProvider<Money>((ref) async {
  return ref.watch(apiClientProvider).balance();
});

final transactionsProvider = FutureProvider<List<WalletTransaction>>((ref) async {
  return ref.watch(apiClientProvider).transactions();
});
