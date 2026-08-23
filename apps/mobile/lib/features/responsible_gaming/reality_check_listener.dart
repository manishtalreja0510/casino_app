import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import 'rg_providers.dart';

/// Shows a reality check when the server sends one, wherever the player happens to be.
///
/// Mounted above the router rather than on a screen, because a check that only appears on
/// some screens is one a player can stay away from. The client decides nothing about when
/// it is due, what it says, or what happens if it is ignored — all three are the server's
/// (`rg.service.ts`), and ignoring it pauses new play there whether or not this widget ever
/// drew anything.
class RealityCheckListener extends ConsumerStatefulWidget {
  const RealityCheckListener({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<RealityCheckListener> createState() => _RealityCheckListenerState();
}

class _RealityCheckListenerState extends ConsumerState<RealityCheckListener> {
  bool _showing = false;

  @override
  Widget build(BuildContext context) {
    ref.listen(realityCheckProvider, (previous, next) {
      final event = next.valueOrNull;
      if (event != null) _show(event.payload);
    });

    return widget.child;
  }

  Future<void> _show(Map<String, dynamic> payload) async {
    // One at a time: a second check stacked on the first is a modal the player cannot
    // dismiss, which is the opposite of the intent.
    if (_showing) return;
    _showing = true;

    final navigator = Navigator.of(context, rootNavigator: true);
    final staked = payload['staked'] as int? ?? 0;
    final net = payload['net'] as int? ?? 0;

    try {
      await showDialog<void>(
        context: navigator.context,
        barrierDismissible: false,
        builder: (dialogContext) => AppDialog(
          title: 'You have been playing for a while',
          message: 'Today you have staked ${_money(staked)} and you are '
              '${net < 0 ? 'down' : 'up'} ${_money(net.abs())}.',
          actions: [
            AppButton(
              label: 'Take a break',
              variant: AppButtonVariant.secondary,
              onPressed: () => Navigator.of(dialogContext).pop(),
            ),
            AppButton(
              label: 'Keep playing',
              onPressed: () => Navigator.of(dialogContext).pop(),
            ),
          ],
        ),
      );

      // Acknowledged when it is dismissed, whichever button did it: the point is that a
      // person saw it. What they do next is their business, and play is paused server-side
      // until this call lands either way.
      await ref.read(apiClientProvider).acknowledgeRealityCheck();
    } on ApiException {
      // Nothing to tell the player: the server already knows what it sent, and it will
      // send another.
    } on NetworkException {
      // Same. The check stands until an acknowledgement reaches the server.
    } finally {
      _showing = false;
    }
  }

  static String _money(int minorUnits) => '${(minorUnits / 100).toStringAsFixed(2)} TST';
}
