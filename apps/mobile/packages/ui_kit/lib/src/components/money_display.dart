import 'package:flutter/material.dart';

import '../theme.dart';

enum MoneyTone { neutral, positive, negative }

/// Displays an already-formatted monetary amount.
///
/// It takes a **string**, deliberately. `ui_kit` performs no money arithmetic and no
/// formatting: amounts are integer minor units owned by the API client, and the client
/// never computes balances — the server is authoritative (rules 1, 4). A component that
/// accepted a number would invite exactly the client-side maths this project forbids.
///
/// Tabular figures come from the `mono` type token so digits do not jitter as values change.
class BalanceDisplay extends StatelessWidget {
  const BalanceDisplay({
    super.key,
    required this.formattedAmount,
    this.label,
    this.tone = MoneyTone.neutral,
    this.large = false,
  });

  final String formattedAmount;
  final String? label;
  final MoneyTone tone;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final color = switch (tone) {
      MoneyTone.neutral => t.colors.textPrimary,
      MoneyTone.positive => t.colors.success,
      MoneyTone.negative => t.colors.danger,
    };
    final style = large
        ? t.text.display.copyWith(color: color, fontFeatures: const [FontFeature.tabularFigures()])
        : t.text.mono.copyWith(color: color);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (label != null) ...[
          Text(label!, style: t.text.label.copyWith(color: t.colors.textSecondary)),
          SizedBox(height: t.space.xs),
        ],
        Text(formattedAmount, style: style),
      ],
    );
  }
}
