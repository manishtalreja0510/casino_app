import 'package:flutter/material.dart';

import '../theme.dart';

/// What phase a round is in, from the component's point of view.
///
/// Deliberately its own enum rather than the API client's: `ui_kit` depends on Flutter
/// alone, so the designer's restyle in P19 cannot be blocked by a contract change, and a
/// contract change cannot break the widget.
enum MultiplierPhase { waiting, rising, crashed }

/// The multiplier a round is currently at.
///
/// **Cosmetic, like every clock in this app.** The number shown here is what the server
/// last said, interpolated between updates so the curve reads smoothly. It is not what a
/// cash-out is priced at: the server prices that from its own clock, and a player whose
/// screen says 4.10× may well cash out at 4.08× — or lose, if the round has already
/// crashed. Nothing here decides anything (rules 2, 21).
class AppMultiplierDisplay extends StatelessWidget {
  const AppMultiplierDisplay({
    super.key,
    required this.multiplierX100,
    required this.phase,
    this.caption,
  });

  /// Multiplier ×100, exactly as it travels on the wire — 250 is 2.50×.
  final int multiplierX100;
  final MultiplierPhase phase;

  /// A line under the number: a countdown, "cashed out", a crash point.
  final String? caption;

  static String format(int multiplierX100) => '${(multiplierX100 / 100).toStringAsFixed(2)}x';

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final color = switch (phase) {
      MultiplierPhase.waiting => t.colors.textSecondary,
      MultiplierPhase.rising => t.colors.success,
      MultiplierPhase.crashed => t.colors.danger,
    };

    return Semantics(
      liveRegion: phase == MultiplierPhase.rising,
      label: 'Multiplier ${format(multiplierX100)}',
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedDefaultTextStyle(
            duration: t.motion.quick,
            style: t.text.display.copyWith(color: color),
            child: Text(format(multiplierX100)),
          ),
          if (caption != null) ...[
            SizedBox(height: t.space.xs),
            Text(
              caption!,
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ],
      ),
    );
  }
}

/// The last few round outcomes, newest first.
///
/// Decoration and nothing else: past rounds say nothing about the next one, and the
/// component must never be dressed up to suggest otherwise (no trend arrows, no "due"
/// markers). It exists because players want to see what just happened, which is a
/// different thing from a prediction.
class AppOutcomeStrip extends StatelessWidget {
  const AppOutcomeStrip({super.key, required this.outcomesX100, this.maxItems = 10});

  final List<int> outcomesX100;
  final int maxItems;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final shown = outcomesX100.take(maxItems).toList();

    if (shown.isEmpty) {
      return Text(
        'No rounds yet',
        style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
      );
    }

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final outcome in shown)
            Padding(
              padding: EdgeInsets.only(right: t.space.xs),
              child: Container(
                padding: EdgeInsets.symmetric(
                  horizontal: t.space.sm,
                  vertical: t.space.xs,
                ),
                decoration: BoxDecoration(
                  color: t.colors.surfaceRaised,
                  borderRadius: BorderRadius.circular(t.space.xs),
                  border: Border.all(
                    // A round that never got off the ground reads differently from one
                    // that flew — the only distinction the strip is allowed to draw.
                    color: outcome <= 100 ? t.colors.danger : t.colors.border,
                  ),
                ),
                child: Text(
                  AppMultiplierDisplay.format(outcome),
                  style: t.text.mono.copyWith(color: t.colors.textPrimary),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
