import 'package:flutter/material.dart';

import '../theme.dart';

/// Turn/round timer.
///
/// **Cosmetic only.** The server owns every deadline and decides when a turn expires
/// (rule 2); this widget renders a value it is given and never decides anything. A
/// client whose clock is wrong — or manipulated — changes what the player *sees*, and
/// nothing about what the server does.
class CountdownRing extends StatelessWidget {
  const CountdownRing({
    super.key,
    required this.remaining,
    required this.total,
    this.size = 48,
    this.label,
  });

  final Duration remaining;
  final Duration total;
  final double size;
  final String? label;

  double get _progress {
    if (total.inMilliseconds <= 0) return 0;
    return (remaining.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    // Urgency is derived from the fraction remaining, not a hardcoded threshold in seconds,
    // so it reads correctly for a 5-second turn and a 60-second one alike.
    final color = switch (_progress) {
      < 0.25 => t.colors.danger,
      < 0.5 => t.colors.warning,
      _ => t.colors.primary,
    };

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox.expand(
            child: CircularProgressIndicator(
              value: _progress,
              strokeWidth: t.space.xs,
              backgroundColor: t.colors.border,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
          Text(
            label ?? '${remaining.inSeconds}',
            style: t.text.mono.copyWith(color: color, fontSize: size / 3),
          ),
        ],
      ),
    );
  }
}
