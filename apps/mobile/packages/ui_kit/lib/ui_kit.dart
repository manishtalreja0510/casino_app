/// The app's only source of visual components.
///
/// Screens compose these and read tokens; they never define one-off styled widgets and
/// never hardcode a colour, size, radius or duration (rule 25). This package depends on
/// Flutter alone — no app code, no state management, no networking — so the designer's
/// restyle in P19 cannot break behaviour.
library;

export 'src/animations/animations.dart';
export 'src/components/button.dart';
export 'src/components/countdown_ring.dart';
export 'src/components/input.dart';
export 'src/components/money_display.dart';
export 'src/components/multiplier_display.dart';
export 'src/components/states.dart';
export 'src/components/surfaces.dart';
export 'src/theme.dart';
export 'src/tokens/colors.dart';
export 'src/tokens/motion.dart';
export 'src/tokens/spacing.dart';
export 'src/tokens/typography.dart';
