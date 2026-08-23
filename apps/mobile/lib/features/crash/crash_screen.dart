import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../auth/auth_controller.dart';
import '../wallet/wallet_providers.dart';
import 'crash_providers.dart';

/// The Crash table.
///
/// A thin shell over server state, like every screen here: it renders the round the server
/// describes and forwards two intents — bet, cash out. It does not decide whether betting
/// is open, what a cash-out is worth, or whether the player won. The rising number is a
/// picture of the server's curve, and the screen says so where it matters (rules 1, 21).
class CrashScreen extends ConsumerStatefulWidget {
  const CrashScreen({super.key, required this.tierId});

  final String tierId;

  @override
  ConsumerState<CrashScreen> createState() => _CrashScreenState();
}

class _CrashScreenState extends ConsumerState<CrashScreen> {
  final _amount = TextEditingController();
  final _autoCashOut = TextEditingController();

  @override
  void dispose() {
    _amount.dispose();
    _autoCashOut.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final state = ref.watch(crashControllerProvider(widget.tierId));
    final controller = ref.read(crashControllerProvider(widget.tierId).notifier);

    ref.listen(crashControllerProvider(widget.tierId), (previous, next) {
      if (next.message != null && next.message != previous?.message) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next.message!)));
        // Any accepted bet or cash-out changed the balance; the server is re-asked rather
        // than the client adjusting a number it does not own (rule 21).
        ref.invalidate(balanceProvider);
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Crash')),
      body: switch (state) {
        CrashViewState(error: final error?) => AppErrorState(
          title: 'Could not load this table',
          supportReference: error is ApiException ? error.traceId : null,
          onRetry: controller.refresh,
        ),
        CrashViewState(round: null) => const AppLoadingState(message: 'Finding the table…'),
        CrashViewState(round: final round?) => ListView(
          padding: EdgeInsets.all(t.space.md),
          children: [
            _RoundPanel(round: round, drawnMultiplierX100: state.drawnMultiplierX100),
            SizedBox(height: t.space.md),
            _BetPanel(
              round: round,
              state: state,
              amount: _amount,
              autoCashOut: _autoCashOut,
              onBet: controller.placeBet,
              onCashOut: controller.cashOut,
            ),
            SizedBox(height: t.space.md),
            _FairnessPanel(round: round),
          ],
        ),
      },
    );
  }
}

class _RoundPanel extends StatelessWidget {
  const _RoundPanel({required this.round, required this.drawnMultiplierX100});

  final CrashRound round;
  final int drawnMultiplierX100;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    final (phase, caption) = switch (round.phase) {
      CrashPhase.betting => (
        MultiplierPhase.waiting,
        round.isOpenForBets ? 'Betting is open' : 'Waiting for the next round',
      ),
      CrashPhase.flying => (MultiplierPhase.rising, 'In flight'),
      CrashPhase.crashed => (MultiplierPhase.crashed, 'Crashed'),
    };

    return AppCard(
      child: Column(
        children: [
          AppMultiplierDisplay(
            multiplierX100: drawnMultiplierX100,
            phase: phase,
            caption: caption,
          ),
          SizedBox(height: t.space.md),
          AppOutcomeStrip(outcomesX100: round.history),
          SizedBox(height: t.space.md),
          _BetBoard(round: round),
        ],
      ),
    );
  }
}

/// Who is in this round, and how they did.
///
/// Other players' stakes and cash-outs are public here by design: watching people bail is
/// most of what makes the game social, and it is a decision already made, not a secret.
/// What nobody sees is another player's auto-cash-out target, which the server never sends.
class _BetBoard extends StatelessWidget {
  const _BetBoard({required this.round});

  final CrashRound round;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (round.bets.isEmpty) {
      return Text(
        'No bets yet',
        style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
      );
    }

    return Column(
      children: [
        for (final bet in round.bets)
          Padding(
            padding: EdgeInsets.only(bottom: t.space.xs),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    // No display names in a public board: the roster is not a place to
                    // leak who plays with whom (rule 15).
                    'Player ${bet.userId.substring(0, 4)}',
                    style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
                  ),
                ),
                BalanceDisplay(formattedAmount: bet.amount.format()),
                SizedBox(width: t.space.sm),
                Text(
                  bet.cashedOutAtX100 == null ? '—' : formatMultiplier(bet.cashedOutAtX100!),
                  textAlign: TextAlign.end,
                  style: t.text.mono.copyWith(
                    color: bet.cashedOutAtX100 == null
                        ? t.colors.textSecondary
                        : t.colors.success,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _BetPanel extends ConsumerWidget {
  const _BetPanel({
    required this.round,
    required this.state,
    required this.amount,
    required this.autoCashOut,
    required this.onBet,
    required this.onCashOut,
  });

  final CrashRound round;
  final CrashViewState state;
  final TextEditingController amount;
  final TextEditingController autoCashOut;
  final Future<void> Function({required int amountMinorUnits, int? autoCashOutX100}) onBet;
  final Future<void> Function() onCashOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final userId = ref.watch(authControllerProvider).user?.id;
    final myBet = round.betFor(userId);

    final riding =
        round.phase == CrashPhase.flying && myBet != null && myBet.cashedOutAtX100 == null;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Bet between ${round.betMin.format()} and ${round.betMax.format()}',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
          SizedBox(height: t.space.sm),
          AppInput(
            label: 'Bet',
            controller: amount,
            hint: 'Amount',
            enabled: round.isOpenForBets && myBet == null && !state.busy,
            keyboardType: TextInputType.number,
            // Digits only. UX, not validation: the server re-checks every bound and is
            // the only thing that can accept a bet.
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          ),
          SizedBox(height: t.space.sm),
          AppInput(
            label: 'Auto cash-out (optional)',
            controller: autoCashOut,
            hint: 'e.g. 200 for 2.00x',
            enabled: round.isOpenForBets && myBet == null && !state.busy,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          ),
          SizedBox(height: t.space.xs),
          Text(
            'An auto cash-out is honoured by the server even if you lose connection. '
            'Without one, a bet rides until the round crashes.',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
          SizedBox(height: t.space.md),
          if (riding)
            AppButton(
              label: 'Cash out',
              onPressed: state.busy ? null : onCashOut,
            )
          else
            AppButton(
              label: myBet == null ? 'Place bet' : 'Bet placed',
              onPressed: round.isOpenForBets && myBet == null && !state.busy
                  ? () => onBet(
                      amountMinorUnits: int.tryParse(amount.text) ?? 0,
                      autoCashOutX100: int.tryParse(autoCashOut.text),
                    )
                  : null,
            ),
          if (myBet != null && myBet.payout != null) ...[
            SizedBox(height: t.space.sm),
            AppBanner(
              message: myBet.payout!.amount > 0
                  ? 'You won ${myBet.payout!.format()}'
                  : 'You lost ${myBet.amount.format()}',
              tone: myBet.payout!.amount > 0 ? AppBannerTone.success : AppBannerTone.danger,
            ),
          ],
        ],
      ),
    );
  }
}

/// The provable-fairness panel.
///
/// The hash is published before betting opens and the seed after the round ends, so a
/// player can check that the outcome was fixed before anyone staked anything. It proves
/// exactly that and nothing more — it does not make the game favourable, and the house
/// edge is a disclosed part of the published formula, not a secret in it.
class _FairnessPanel extends StatelessWidget {
  const _FairnessPanel({required this.round});

  final CrashRound round;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Fairness', style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
          SizedBox(height: t.space.xs),
          Text(
            'The crash point of this round was fixed before betting opened. The hash below '
            'was published first; the seed is revealed when the round ends.',
            style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
          ),
          SizedBox(height: t.space.sm),
          _Field(label: 'Commitment', value: round.commitment),
          _Field(label: 'Server seed', value: round.serverSeed ?? 'revealed after the round'),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: EdgeInsets.only(bottom: t.space.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: t.text.label.copyWith(color: t.colors.textSecondary)),
          SelectableText(
            value,
            style: t.text.mono.copyWith(color: t.colors.textPrimary),
          ),
        ],
      ),
    );
  }
}
