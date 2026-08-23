import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../wallet/wallet_providers.dart';
import 'lobby_providers.dart';

/// Game selection and matchmaking.
///
/// A thin shell: it shows what the server reports and forwards the player's intent. It
/// never decides whether a tier is joinable, whether funds suffice, or when a match has
/// formed — every one of those is the server's answer (rule 21).
class LobbyScreen extends ConsumerWidget {
  const LobbyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final lobby = ref.watch(lobbyProvider);
    final queuedTier = ref.watch(queuedTierProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Play')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(lobbyProvider);
          await ref.read(lobbyProvider.future);
        },
        child: lobby.when(
          loading: () => const AppLoadingState(message: 'Loading games…'),
          error: (error, _) => AppErrorState(
            title: 'Could not load the lobby',
            supportReference: error is ApiException ? error.traceId : null,
            onRetry: () => ref.invalidate(lobbyProvider),
          ),
          data: (games) => games.isEmpty
              ? const AppEmptyState(
                  title: 'No games available',
                  message: 'Check back shortly.',
                )
              : ListView(
                  padding: EdgeInsets.all(t.space.md),
                  children: [
                    for (final game in games) ...[
                      _GameCard(game: game, queuedTier: queuedTier),
                      SizedBox(height: t.space.md),
                    ],
                  ],
                ),
        ),
      ),
    );
  }
}

class _GameCard extends ConsumerWidget {
  const _GameCard({required this.game, required this.queuedTier});

  final LobbyGame game;
  final String? queuedTier;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;

    // Subscribe to this game's lobby room so queue depths and match counts stay live.
    ref.watch(lobbyLiveProvider(game.gameCode));

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  game.name,
                  style: t.text.titleMedium.copyWith(color: t.colors.textPrimary),
                ),
              ),
              Text(
                '${game.activeMatches} live',
                style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
              ),
            ],
          ),
          if (!game.enabled) ...[
            SizedBox(height: t.space.sm),
            const AppBanner(
              message: 'This game is temporarily unavailable.',
              tone: AppBannerTone.warning,
              icon: Icons.pause_circle_outline,
            ),
          ],
          SizedBox(height: t.space.md),
          for (final tier in game.tiers) ...[
            _TierRow(game: game, tier: tier, queuedTier: queuedTier),
            SizedBox(height: t.space.sm),
          ],
        ],
      ),
    );
  }
}

class _TierRow extends ConsumerWidget {
  const _TierRow({required this.game, required this.tier, required this.queuedTier});

  final LobbyGame game;
  final StakeTier tier;
  final String? queuedTier;

  bool get _isQueuedHere => queuedTier == tier.id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    // Queued elsewhere: the server allows only one queue at a time, so the UI reflects it
    // rather than letting the player discover it through an error.
    final blockedByOtherQueue = queuedTier != null && !_isQueuedHere;

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(tier.name, style: t.text.body.copyWith(color: t.colors.textPrimary)),
              Text(
                tier.isFree ? 'Free play' : tier.stake.format(),
                style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
              ),
            ],
          ),
        ),
        if (game.mode == LobbyMode.matchmade && tier.queueDepth > 0) ...[
          Text(
            '${tier.queueDepth} waiting',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
          SizedBox(width: t.space.sm),
        ],
        // A round game has no queue to join: its betting window *is* the queue, so the
        // lobby sends the player to the table (ADR-023). Decided from the mode the server
        // reports, never from the game's name.
        if (game.mode == LobbyMode.rounds)
          AppButton(
            label: 'Play',
            onPressed: game.enabled ? () => context.push(AppRoutes.crash(tier.id)) : null,
          )
        else
          AppButton(
            label: _isQueuedHere ? 'Leave' : 'Join',
            variant: _isQueuedHere ? AppButtonVariant.secondary : AppButtonVariant.primary,
            onPressed: !game.enabled || blockedByOtherQueue
                ? null
                : () => _isQueuedHere ? _leave(context, ref) : _join(context, ref),
          ),
      ],
    );
  }

  Future<void> _join(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final status = await ref.read(apiClientProvider).joinQueue(tier.id);

      if (status.matchId != null) {
        // Joining completed a pairing: the match already exists and both players were
        // charged in one transaction server-side.
        ref.read(queuedTierProvider.notifier).state = null;
        ref.invalidate(balanceProvider);
        messenger.showSnackBar(SnackBar(content: Text('Match found: ${status.matchId}')));
      } else {
        ref.read(queuedTierProvider.notifier).state = tier.id;
      }
      ref.invalidate(lobbyProvider);
    } on ApiException catch (error) {
      // Insufficient funds, already in a match, game disabled — all decided server-side.
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(const SnackBar(content: Text('Cannot reach the server.')));
    }
  }

  Future<void> _leave(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiClientProvider).leaveQueue(tier.id);
      ref.read(queuedTierProvider.notifier).state = null;
      ref.invalidate(lobbyProvider);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(const SnackBar(content: Text('Cannot reach the server.')));
    }
  }
}
