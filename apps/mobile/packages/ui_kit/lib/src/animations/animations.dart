import 'package:flutter/material.dart';

import '../theme.dart';

/// Intent-named animation wrappers (`asset-animation-pipeline.md`, ADR-019).
///
/// The contract with P19: **the public API of each wrapper is the intent and its
/// callbacks — never the implementation.** No controller, no Rive/Lottie type, and no
/// duration literal leaks to a call site, so swapping the placeholder implementation for
/// a designed animation is an edit inside this file only.
///
/// Placeholder implementations use built-in Flutter animations, timed from motion tokens.

/// A card being dealt to a seat. Placeholder: slide + fade in.
class CardDealAnimation extends StatefulWidget {
  const CardDealAnimation({
    super.key,
    required this.child,
    this.delay = Duration.zero,
    this.onComplete,
  });

  final Widget child;
  final Duration delay;
  final VoidCallback? onComplete;

  @override
  State<CardDealAnimation> createState() => _CardDealAnimationState();
}

class _CardDealAnimationState extends State<CardDealAnimation> with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_controller != null) return;

    final motion = context.tokens.motion;
    final controller = AnimationController(vsync: this, duration: motion.standard);
    _controller = controller;
    controller.addStatusListener((status) {
      if (status == AnimationStatus.completed) widget.onComplete?.call();
    });
    Future<void>.delayed(widget.delay, () {
      if (mounted) controller.forward();
    });
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return const SizedBox.shrink();

    final curve = CurvedAnimation(parent: controller, curve: context.tokens.motion.enter);
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Opacity(
        opacity: curve.value,
        child: Transform.translate(
          offset: Offset(0, (1 - curve.value) * -24),
          child: child,
        ),
      ),
      child: widget.child,
    );
  }
}

/// Celebrates a win. Placeholder: a scale pulse.
class WinCelebration extends StatefulWidget {
  const WinCelebration({super.key, required this.child, this.play = true, this.onComplete});

  final Widget child;
  final bool play;
  final VoidCallback? onComplete;

  @override
  State<WinCelebration> createState() => _WinCelebrationState();
}

class _WinCelebrationState extends State<WinCelebration> with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_controller != null) return;

    final controller = AnimationController(vsync: this, duration: context.tokens.motion.celebration);
    _controller = controller;
    controller.addStatusListener((status) {
      if (status == AnimationStatus.completed) widget.onComplete?.call();
    });
    if (widget.play) controller.forward();
  }

  @override
  void didUpdateWidget(WinCelebration oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.play && !oldWidget.play) _controller?.forward(from: 0);
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return widget.child;

    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) {
        final pulse = 1 + 0.12 * (1 - (controller.value * 2 - 1).abs());
        return Transform.scale(scale: pulse, child: child);
      },
      child: widget.child,
    );
  }
}

/// Chips moving between a player and the pot. Placeholder: a translate along the path.
class ChipMoveAnimation extends StatefulWidget {
  const ChipMoveAnimation({
    super.key,
    required this.child,
    required this.from,
    required this.to,
    this.onComplete,
  });

  final Widget child;
  final Offset from;
  final Offset to;
  final VoidCallback? onComplete;

  @override
  State<ChipMoveAnimation> createState() => _ChipMoveAnimationState();
}

class _ChipMoveAnimationState extends State<ChipMoveAnimation> with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_controller != null) return;

    final controller = AnimationController(vsync: this, duration: context.tokens.motion.slow);
    _controller = controller;
    controller.addStatusListener((status) {
      if (status == AnimationStatus.completed) widget.onComplete?.call();
    });
    controller.forward();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return const SizedBox.shrink();

    final curve = CurvedAnimation(parent: controller, curve: context.tokens.motion.emphasis);
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Transform.translate(
        offset: Offset.lerp(widget.from, widget.to, curve.value)!,
        child: child,
      ),
      child: widget.child,
    );
  }
}
