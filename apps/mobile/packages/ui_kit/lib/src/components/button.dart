import 'package:flutter/material.dart';

import '../theme.dart';

enum AppButtonVariant { primary, secondary, danger, ghost }

/// The only button in the app.
///
/// Variants are *intents* (`danger` = destructive/irreversible), not colours, so the
/// designer can recolour them without call sites lying about what they do.
class AppButton extends StatelessWidget {
  const AppButton({
    super.key,
    required this.label,
    this.onPressed,
    this.variant = AppButtonVariant.primary,
    this.loading = false,
    this.expand = false,
    this.icon,
  });

  final String label;

  /// Null disables the button. A loading button is also non-interactive — double
  /// submission of a financial action must be impossible from the UI as well as
  /// idempotent on the server (rule 6).
  final VoidCallback? onPressed;
  final AppButtonVariant variant;
  final bool loading;
  final bool expand;
  final IconData? icon;

  bool get _enabled => onPressed != null && !loading;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (background, foreground, border) = switch (variant) {
      AppButtonVariant.primary => (t.colors.primary, t.colors.onPrimary, null),
      AppButtonVariant.secondary => (t.colors.surfaceRaised, t.colors.textPrimary, t.colors.border),
      AppButtonVariant.danger => (t.colors.danger, t.colors.onPrimary, null),
      AppButtonVariant.ghost => (const Color(0x00000000), t.colors.textSecondary, null),
    };

    return Opacity(
      opacity: _enabled ? 1 : 0.5,
      child: Semantics(
        button: true,
        enabled: _enabled,
        label: label,
        child: Material(
          color: background,
          borderRadius: BorderRadius.circular(t.space.radiusMd),
          child: InkWell(
            onTap: _enabled ? onPressed : null,
            borderRadius: BorderRadius.circular(t.space.radiusMd),
            child: Container(
              width: expand ? double.infinity : null,
              padding: EdgeInsets.symmetric(horizontal: t.space.lg, vertical: t.space.md),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(t.space.radiusMd),
                border: border == null ? null : Border.all(color: border, width: t.space.borderWidth),
              ),
              child: Row(
                mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (loading) ...[
                    SizedBox(
                      width: t.space.md,
                      height: t.space.md,
                      child: CircularProgressIndicator(strokeWidth: 2, color: foreground),
                    ),
                    SizedBox(width: t.space.sm),
                  ] else if (icon != null) ...[
                    Icon(icon, size: t.space.md + t.space.xs, color: foreground),
                    SizedBox(width: t.space.sm),
                  ],
                  Flexible(
                    child: Text(
                      label,
                      overflow: TextOverflow.ellipsis,
                      style: t.text.label.copyWith(color: foreground),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
