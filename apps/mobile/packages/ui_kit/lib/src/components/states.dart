import 'package:flutter/material.dart';

import '../theme.dart';
import 'button.dart';

/// Empty state. Every list gets one — "nothing here" is a designed state, not a blank screen.
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({super.key, required this.title, this.message, this.actionLabel, this.onAction});

  final String title;
  final String? message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Center(
      child: Padding(
        padding: EdgeInsets.all(t.space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, textAlign: TextAlign.center, style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
            if (message != null) ...[
              SizedBox(height: t.space.sm),
              Text(message!, textAlign: TextAlign.center, style: t.text.body.copyWith(color: t.colors.textSecondary)),
            ],
            if (actionLabel != null) ...[
              SizedBox(height: t.space.lg),
              AppButton(label: actionLabel!, onPressed: onAction, variant: AppButtonVariant.secondary),
            ],
          ],
        ),
      ),
    );
  }
}

class AppLoadingState extends StatelessWidget {
  const AppLoadingState({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(color: t.colors.primary),
          if (message != null) ...[
            SizedBox(height: t.space.md),
            Text(message!, style: t.text.bodySmall.copyWith(color: t.colors.textSecondary)),
          ],
        ],
      ),
    );
  }
}

/// Error state.
///
/// `supportReference` is the server's `traceId`: it is what support correlates against
/// the logs, and it is deliberately the *only* internal detail a player ever sees
/// (rule 15).
class AppErrorState extends StatelessWidget {
  const AppErrorState({
    super.key,
    required this.title,
    this.message,
    this.supportReference,
    this.onRetry,
  });

  final String title;
  final String? message;
  final String? supportReference;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Center(
      child: Padding(
        padding: EdgeInsets.all(t.space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: t.colors.danger, size: t.space.xl),
            SizedBox(height: t.space.md),
            Text(title, textAlign: TextAlign.center, style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
            if (message != null) ...[
              SizedBox(height: t.space.sm),
              Text(message!, textAlign: TextAlign.center, style: t.text.body.copyWith(color: t.colors.textSecondary)),
            ],
            if (supportReference != null) ...[
              SizedBox(height: t.space.sm),
              Text(
                'Reference: $supportReference',
                style: t.text.bodySmall.copyWith(color: t.colors.textDisabled),
              ),
            ],
            if (onRetry != null) ...[
              SizedBox(height: t.space.lg),
              AppButton(label: 'Try again', onPressed: onRetry, variant: AppButtonVariant.secondary),
            ],
          ],
        ),
      ),
    );
  }
}
