import 'package:flutter/material.dart';

import '../theme.dart';

/// Grouping surface. Raised cards read as interactive; flat cards are containers.
class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.onTap, this.raised = false, this.padded = true});

  final Widget child;
  final VoidCallback? onTap;
  final bool raised;
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final content = Container(
      padding: padded ? EdgeInsets.all(t.space.md) : EdgeInsets.zero,
      decoration: BoxDecoration(
        color: raised ? t.colors.surfaceRaised : t.colors.surface,
        borderRadius: BorderRadius.circular(t.space.radiusLg),
        border: Border.all(color: t.colors.border, width: t.space.borderWidth),
      ),
      child: child,
    );

    if (onTap == null) return content;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(t.space.radiusLg),
      child: content,
    );
  }
}

/// Modal dialog. Actions are supplied by the caller so intent stays explicit.
class AppDialog extends StatelessWidget {
  const AppDialog({super.key, required this.title, required this.message, this.actions = const []});

  final String title;
  final String message;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Dialog(
      backgroundColor: t.colors.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.space.radiusLg)),
      child: Padding(
        padding: EdgeInsets.all(t.space.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
            SizedBox(height: t.space.sm),
            Text(message, style: t.text.body.copyWith(color: t.colors.textSecondary)),
            if (actions.isNotEmpty) ...[
              SizedBox(height: t.space.lg),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: _spaced(actions, t.space.sm)),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _spaced(List<Widget> widgets, double gap) => [
        for (var i = 0; i < widgets.length; i++) ...[
          if (i > 0) SizedBox(width: gap),
          widgets[i],
        ],
      ];
}

enum AppBannerTone { info, success, warning, danger }

/// Inline status banner. Also the offline indicator (`AppBannerTone.warning`) — connection
/// loss is a temporary condition, not an error the player caused.
class AppBanner extends StatelessWidget {
  const AppBanner({super.key, required this.message, this.tone = AppBannerTone.info, this.icon, this.action});

  final String message;
  final AppBannerTone tone;
  final IconData? icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final color = switch (tone) {
      AppBannerTone.info => t.colors.info,
      AppBannerTone.success => t.colors.success,
      AppBannerTone.warning => t.colors.warning,
      AppBannerTone.danger => t.colors.danger,
    };

    return Container(
      width: double.infinity,
      padding: EdgeInsets.symmetric(horizontal: t.space.md, vertical: t.space.sm),
      decoration: BoxDecoration(
        color: t.colors.surfaceRaised,
        border: Border(left: BorderSide(color: color, width: t.space.xs)),
        borderRadius: BorderRadius.circular(t.space.radiusSm),
      ),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: t.space.md, color: color),
            SizedBox(width: t.space.sm),
          ],
          Expanded(child: Text(message, style: t.text.bodySmall.copyWith(color: t.colors.textPrimary))),
          if (action != null) ...[SizedBox(width: t.space.sm), action!],
        ],
      ),
    );
  }
}
