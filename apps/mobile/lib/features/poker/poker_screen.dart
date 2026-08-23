import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../auth/auth_controller.dart';
import '../wallet/wallet_providers.dart';
import 'poker_providers.dart';

/// A poker table.
///
/// A thin shell over server state, and the strictest example of it in the app: the only
/// hole cards it ever holds are its own player's, because they are the only ones the
/// server sends. Which actions are offered, and what a raise may be, come from the server
/// too — the client disables what was not offered and the server re-checks anyway.
class PokerScreen extends ConsumerStatefulWidget {
  const PokerScreen({super.key, required this.tableId});

  final String tableId;

  @override
  ConsumerState<PokerScreen> createState() => _PokerScreenState();
}

class _PokerScreenState extends ConsumerState<PokerScreen> {
  final _buyIn = TextEditingController();
  final _raiseTo = TextEditingController();

  @override
  void dispose() {
    _buyIn.dispose();
    _raiseTo.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final state = ref.watch(pokerControllerProvider(widget.tableId));
    final controller = ref.read(pokerControllerProvider(widget.tableId).notifier);

    ref.listen(pokerControllerProvider(widget.tableId), (previous, next) {
      if (next.message != null && next.message != previous?.message) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next.message!)));
        ref.invalidate(balanceProvider);
      }
    });

    return Scaffold(
      appBar: AppBar(title: Text(state.table?.name ?? 'Poker')),
      body: switch (state) {
        PokerViewState(error: final error?) => AppErrorState(
          title: 'Could not load this table',
          supportReference: error is ApiException ? error.traceId : null,
          onRetry: controller.refresh,
        ),
        PokerViewState(table: null) => const AppLoadingState(message: 'Finding the table…'),
        PokerViewState(table: final table?) => ListView(
          padding: EdgeInsets.all(t.space.md),
          children: [
            _TablePanel(table: table),
            SizedBox(height: t.space.md),
            _SeatList(table: table),
            SizedBox(height: t.space.md),
            _ActionPanel(
              table: table,
              state: state,
              buyIn: _buyIn,
              raiseTo: _raiseTo,
              controller: controller,
            ),
          ],
        ),
      },
    );
  }
}

class _TablePanel extends StatelessWidget {
  const _TablePanel({required this.table});

  final PokerTable table;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final hand = table.hand;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Blinds ${table.smallBlind.format()} / ${table.bigBlind.format()}',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
          SizedBox(height: t.space.sm),
          if (hand == null)
            Text(
              'Waiting for the next hand',
              style: t.text.body.copyWith(color: t.colors.textSecondary),
            )
          else ...[
            Text(
              hand.board.isEmpty ? 'No cards yet' : hand.board.join('  '),
              style: t.text.mono.copyWith(color: t.colors.textPrimary),
            ),
            SizedBox(height: t.space.sm),
            BalanceDisplay(formattedAmount: hand.pot.format(), label: 'Pot'),
            if (hand.shown.isNotEmpty) ...[
              SizedBox(height: t.space.sm),
              for (final shown in hand.shown)
                Text(
                  '${playerLabel(shown.userId)} showed ${shown.cards.join(' ')}',
                  style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
                ),
            ],
          ],
        ],
      ),
    );
  }
}

class _SeatList extends ConsumerWidget {
  const _SeatList({required this.table});

  final PokerTable table;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final me = ref.watch(authControllerProvider).user?.id;
    final hand = table.hand;

    return AppCard(
      child: Column(
        children: [
          for (final seat in table.seats)
            Padding(
              padding: EdgeInsets.only(bottom: t.space.xs),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      seat.userId == me
                          ? 'You (seat ${seat.seatNo})'
                          : '${playerLabel(seat.userId)} (seat ${seat.seatNo})',
                      style: t.text.body.copyWith(
                        color: hand?.toAct == seat.userId
                            ? t.colors.primary
                            : t.colors.textPrimary,
                      ),
                    ),
                  ),
                  // The caller's own cards come from `you`; everyone else's are null until
                  // the hand shows them down, and the server is what makes that true.
                  if (seat.userId == me && hand?.you != null)
                    Text(
                      hand!.you!.cards.join(' '),
                      style: t.text.mono.copyWith(color: t.colors.textPrimary),
                    ),
                  SizedBox(width: t.space.sm),
                  BalanceDisplay(formattedAmount: seat.stack.format()),
                ],
              ),
            ),
          if (table.seats.isEmpty)
            Text(
              'Nobody is sitting yet',
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
            ),
        ],
      ),
    );
  }
}

class _ActionPanel extends ConsumerWidget {
  const _ActionPanel({
    required this.table,
    required this.state,
    required this.buyIn,
    required this.raiseTo,
    required this.controller,
  });

  final PokerTable table;
  final PokerViewState state;
  final TextEditingController buyIn;
  final TextEditingController raiseTo;
  final PokerController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final me = ref.watch(authControllerProvider).user?.id;
    final seated = table.seatOf(me);
    final legal = table.hand?.you?.legal;

    if (seated == null) {
      return AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Buy in between ${table.minBuyIn.format()} and ${table.maxBuyIn.format()}',
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
            ),
            SizedBox(height: t.space.sm),
            AppInput(
              label: 'Buy-in',
              controller: buyIn,
              keyboardType: TextInputType.number,
              enabled: !state.busy && table.hasOpenSeat,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            ),
            SizedBox(height: t.space.md),
            AppButton(
              label: table.hasOpenSeat ? 'Sit down' : 'Table full',
              onPressed: state.busy || !table.hasOpenSeat
                  ? null
                  : () => controller.sit(int.tryParse(buyIn.text) ?? 0),
            ),
          ],
        ),
      );
    }

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (legal == null)
            Text(
              table.hand == null ? 'Waiting for the next hand' : 'Waiting for your turn',
              style: t.text.body.copyWith(color: t.colors.textSecondary),
            )
          else ...[
            Wrap(
              spacing: t.space.sm,
              runSpacing: t.space.sm,
              children: [
                if (legal.canFold)
                  AppButton(
                    label: 'Fold',
                    variant: AppButtonVariant.secondary,
                    onPressed: state.busy ? null : () => controller.act('fold'),
                  ),
                if (legal.canCheck)
                  AppButton(
                    label: 'Check',
                    onPressed: state.busy ? null : () => controller.act('check'),
                  ),
                if (legal.canCall)
                  AppButton(
                    label: 'Call ${legal.callAmount}',
                    onPressed: state.busy ? null : () => controller.act('call'),
                  ),
              ],
            ),
            if (legal.canBet || legal.canRaise) ...[
              SizedBox(height: t.space.sm),
              AppInput(
                label: 'Raise to (min ${legal.minRaiseTo}, max ${legal.maxRaiseTo})',
                controller: raiseTo,
                keyboardType: TextInputType.number,
                enabled: !state.busy,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              ),
              SizedBox(height: t.space.sm),
              AppButton(
                label: legal.canBet ? 'Bet' : 'Raise',
                onPressed: state.busy
                    ? null
                    : () => controller.act(
                        legal.canBet ? 'bet' : 'raise',
                        amount: int.tryParse(raiseTo.text) ?? legal.minRaiseTo,
                      ),
              ),
            ] else if (legal.raiseBlockedReason != null) ...[
              SizedBox(height: t.space.sm),
              // The server's words, not a guess: the rule is worth explaining rather than
              // showing a button that does nothing.
              AppBanner(message: legal.raiseBlockedReason!, tone: AppBannerTone.info),
            ],
          ],
          SizedBox(height: t.space.md),
          AppButton(
            label: 'Stand up',
            variant: AppButtonVariant.secondary,
            onPressed: state.busy ? null : controller.stand,
          ),
          SizedBox(height: t.space.xs),
          Text(
            'Standing up during a hand takes effect when the hand finishes — chips already '
            'in the pot stay there.',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
        ],
      ),
    );
  }
}
