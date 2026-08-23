import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/router.dart';
import 'poker_providers.dart';

/// The list of open poker tables.
///
/// A tier has many tables, so unlike a Crash tier there is a choice to make before there
/// is a game to join. Which tables exist, and how full they are, is the server's answer.
class PokerTablesScreen extends ConsumerWidget {
  const PokerTablesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final tables = ref.watch(pokerTablesProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Poker')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(pokerTablesProvider);
          await ref.read(pokerTablesProvider.future);
        },
        child: tables.when(
          loading: () => const AppLoadingState(message: 'Loading tables…'),
          error: (error, _) => AppErrorState(
            title: 'Could not load the tables',
            supportReference: error is ApiException ? error.traceId : null,
            onRetry: () => ref.invalidate(pokerTablesProvider),
          ),
          data: (list) => list.isEmpty
              ? const AppEmptyState(
                  title: 'No tables running',
                  message: 'Check back shortly.',
                )
              : ListView(
                  padding: EdgeInsets.all(t.space.md),
                  children: [
                    for (final table in list) ...[
                      AppCard(
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    table.name,
                                    style: t.text.titleMedium.copyWith(
                                      color: t.colors.textPrimary,
                                    ),
                                  ),
                                  Text(
                                    '${table.smallBlind.format()} / ${table.bigBlind.format()}'
                                    ' · ${table.seated}/${table.seatCount} seated',
                                    style: t.text.bodySmall.copyWith(
                                      color: t.colors.textSecondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            AppButton(
                              label: table.seated >= table.seatCount ? 'Full' : 'Open',
                              onPressed: table.seated >= table.seatCount
                                  ? null
                                  : () => context.push(AppRoutes.pokerTable(table.tableId)),
                            ),
                          ],
                        ),
                      ),
                      SizedBox(height: t.space.md),
                    ],
                  ],
                ),
        ),
      ),
    );
  }
}
