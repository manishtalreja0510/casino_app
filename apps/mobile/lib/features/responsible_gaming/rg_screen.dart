import 'package:api_client/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import 'rg_providers.dart';

/// The player's own controls: limits, breaks, reality checks, and the record of both.
///
/// The screen renders decisions and collects intentions. It enforces nothing — an
/// exclusion shown here is already binding on every server path whether or not this screen
/// ever draws it, and the confirmation friction below is courtesy, not a control: the
/// server asks for the same words again (`rg.controller.ts`).
///
/// The asymmetry is stated in the copy rather than hidden in the behaviour. A player who
/// tightens a limit is told it is immediate; a player who loosens one is told when it will
/// take effect and offered the way to cancel it. Surprising someone with a 24-hour wait
/// after they tapped Save is how a safety feature becomes a support ticket.
class ResponsibleGamingScreen extends ConsumerWidget {
  const ResponsibleGamingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final status = ref.watch(rgStatusProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Playing safely')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(rgStatusProvider);
          await ref.read(rgStatusProvider.future);
        },
        child: status.when(
          loading: () => const AppLoadingState(),
          error: (error, _) => AppErrorState(
            title: 'Could not load your settings',
            supportReference: error is ApiException ? error.traceId : null,
            onRetry: () => ref.invalidate(rgStatusProvider),
          ),
          data: (data) => ListView(
            padding: EdgeInsets.all(t.space.md),
            children: [
              if (data.exclusion != null) ...[
                _ExclusionBanner(exclusion: data.exclusion!),
                SizedBox(height: t.space.lg),
              ],
              _LimitsSection(status: data),
              SizedBox(height: t.space.lg),
              _RealityCheckSection(status: data),
              SizedBox(height: t.space.lg),
              if (data.exclusion == null) ...[
                const _TakeABreakSection(),
                SizedBox(height: t.space.lg),
              ],
              _HistorySection(status: data),
            ],
          ),
        ),
      ),
    );
  }
}

class _ExclusionBanner extends StatelessWidget {
  const _ExclusionBanner({required this.exclusion});

  final RgExclusion exclusion;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final permanent = exclusion.isPermanent;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppBanner(
          tone: AppBannerTone.warning,
          message: permanent
              ? 'You are self-excluded. Play and deposits are turned off.'
              : 'You are taking a break until ${_formatDate(exclusion.endsAt!)}.',
        ),
        SizedBox(height: t.space.sm),
        // Said plainly and up front, because it is the part people are surprised by, and
        // being surprised by it later is much worse than reading it now.
        Text(
          permanent
              ? 'A self-exclusion cannot be shortened or removed. Support can talk you '
                    'through what happens next.'
              : 'A break cannot be shortened, and it ends on its own. You can make it '
                    'longer at any time.',
          style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
        ),
      ],
    );
  }
}

class _LimitsSection extends ConsumerWidget {
  const _LimitsSection({required this.status});

  final RgStatus status;

  static const _types = <String, String>{
    'deposit': 'Adding funds',
    'wager': 'Stakes',
    'loss': 'Losses',
    'session_time': 'Time played',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Your limits', style: t.text.label.copyWith(color: t.colors.textSecondary)),
        SizedBox(height: t.space.sm),
        for (final entry in _types.entries) ...[
          _LimitCard(
            title: entry.value,
            type: entry.key,
            limit: _limitFor(entry.key),
          ),
          SizedBox(height: t.space.sm),
        ],
      ],
    );
  }

  RgLimit? _limitFor(String type) {
    for (final limit in status.limits) {
      if (limit.type == type) return limit;
    }
    return null;
  }
}

class _LimitCard extends ConsumerWidget {
  const _LimitCard({required this.title, required this.type, this.limit});

  final String title;
  final String type;
  final RgLimit? limit;

  /// A time limit is counted in minutes; everything else is money. The server sends both
  /// as plain integers in the unit the limit is set in, and this only picks the suffix —
  /// no conversion happens on the client, so there is nothing here to get wrong.
  bool get _isTime => type == 'session_time';

  String _amount(int value) => _isTime ? '$value min' : _money(value);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final current = limit;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(title, style: t.text.body.copyWith(color: t.colors.textPrimary)),
              ),
              AppButton(
                label: current == null ? 'Set' : 'Change',
                variant: AppButtonVariant.secondary,
                onPressed: () => _edit(context, ref),
              ),
            ],
          ),
          SizedBox(height: t.space.sm),
          if (current == null)
            Text(
              'No daily limit set.',
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
            )
          else ...[
            Text(
              'Daily limit ${_amount(current.amount)} · '
              '${_amount(current.used)} used · ${_amount(current.remaining)} left',
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
            ),
            if (current.hasPendingIncrease) ...[
              SizedBox(height: t.space.sm),
              AppBanner(
                tone: AppBannerTone.info,
                message: 'A higher limit of ${_amount(current.pendingAmount!)} takes effect '
                    '${_formatDateTime(current.pendingEffectiveAt!)}.',
                action: AppButton(
                  label: 'Cancel',
                  variant: AppButtonVariant.ghost,
                  onPressed: () => _cancelPending(context, ref),
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref) async {
    final controller = TextEditingController(
      text: limit == null ? '' : (_isTime ? limit!.amount : limit!.amount ~/ 100).toString(),
    );
    final t = context.tokens;

    final amount = await showDialog<int>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: t.colors.surface,
        title: Text(title, style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppInput(
              label: _isTime ? 'Daily limit (minutes)' : 'Daily limit',
              controller: controller,
              keyboardType: TextInputType.number,
            ),
            SizedBox(height: t.space.sm),
            // The rule, before the tap rather than after it.
            Text(
              'A lower limit applies straight away. A higher one takes effect after 24 '
              'hours, and you can cancel it until then.',
              style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
            ),
          ],
        ),
        actions: [
          AppButton(
            label: 'Cancel',
            variant: AppButtonVariant.ghost,
            onPressed: () => Navigator.of(dialogContext).pop(),
          ),
          AppButton(
            label: 'Save',
            onPressed: () {
              final parsed = int.tryParse(controller.text.trim());
              Navigator.of(dialogContext).pop(
                parsed == null ? null : (_isTime ? parsed : parsed * 100),
              );
            },
          ),
        ],
      ),
    );

    if (amount == null || !context.mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ref
          .read(apiClientProvider)
          .setRgLimit(type: type, period: 'day', amount: amount);
      ref.invalidate(rgStatusProvider);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            result.effective == 'immediate'
                ? 'Your limit is in force now.'
                : 'Your limit will change on ${_formatDateTime(result.effectiveAt!)}. '
                      'The current one still applies until then.',
          ),
        ),
      );
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(
        const SnackBar(content: Text('Cannot reach the server. Nothing was changed.')),
      );
    }
  }

  Future<void> _cancelPending(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiClientProvider).cancelPendingRgLimit(type: type, period: 'day');
      ref.invalidate(rgStatusProvider);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(
        const SnackBar(content: Text('Cannot reach the server. Nothing was changed.')),
      );
    }
  }
}

class _RealityCheckSection extends ConsumerWidget {
  const _RealityCheckSection({required this.status});

  final RgStatus status;

  static const _options = <int, String>{
    15 * 60 * 1000: 'Every 15 minutes',
    30 * 60 * 1000: 'Every 30 minutes',
    60 * 60 * 1000: 'Every hour',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Reality checks', style: t.text.label.copyWith(color: t.colors.textSecondary)),
        SizedBox(height: t.space.sm),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'We interrupt play to tell you how long you have been at it.',
                style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
              ),
              SizedBox(height: t.space.sm),
              for (final option in _options.entries)
                _IntervalOption(
                  label: option.value,
                  selected: status.realityCheck.intervalMs == option.key,
                  onTap: () => _setInterval(context, ref, option.key),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _setInterval(BuildContext context, WidgetRef ref, int intervalMs) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiClientProvider).setRealityCheckInterval(intervalMs);
      ref.invalidate(rgStatusProvider);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(
        const SnackBar(content: Text('Cannot reach the server. Nothing was changed.')),
      );
    }
  }
}

class _IntervalOption extends StatelessWidget {
  const _IntervalOption({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: t.space.sm),
          child: Row(
            children: [
              Icon(
                selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                size: t.space.md,
                color: selected ? t.colors.primary : t.colors.textSecondary,
              ),
              SizedBox(width: t.space.sm),
              Text(label, style: t.text.body.copyWith(color: t.colors.textPrimary)),
            ],
          ),
        ),
      ),
    );
  }
}

class _TakeABreakSection extends ConsumerWidget {
  const _TakeABreakSection();

  static const _confirmPhrase = 'I understand';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Take a break', style: t.text.label.copyWith(color: t.colors.textSecondary)),
        SizedBox(height: t.space.sm),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'A break turns off play and deposits until it ends. It cannot be '
                'shortened, by you or by us.',
                style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
              ),
              SizedBox(height: t.space.md),
              AppButton(
                label: 'Take 24 hours off',
                variant: AppButtonVariant.secondary,
                expand: true,
                onPressed: () => _start(
                  context,
                  ref,
                  kind: 'cool_off',
                  durationMs: 24 * 60 * 60 * 1000,
                  title: 'Take 24 hours off',
                  message: 'Play and deposits stop for 24 hours. This cannot be undone or '
                      'shortened. Type "$_confirmPhrase" to confirm.',
                ),
              ),
              SizedBox(height: t.space.sm),
              AppButton(
                label: 'Take 30 days off',
                variant: AppButtonVariant.secondary,
                expand: true,
                onPressed: () => _start(
                  context,
                  ref,
                  kind: 'cool_off',
                  durationMs: 30 * 24 * 60 * 60 * 1000,
                  title: 'Take 30 days off',
                  message: 'Play and deposits stop for 30 days. This cannot be undone or '
                      'shortened. Type "$_confirmPhrase" to confirm.',
                ),
              ),
              SizedBox(height: t.space.md),
              AppButton(
                label: 'Self-exclude permanently',
                variant: AppButtonVariant.danger,
                expand: true,
                onPressed: () => _start(
                  context,
                  ref,
                  kind: 'self_exclusion',
                  durationMs: null,
                  title: 'Self-exclude permanently',
                  message: 'This is permanent. Play and deposits stop and cannot be turned '
                      'back on by you or by support. Type "$_confirmPhrase" to confirm.',
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Typed confirmation for every break, not only the permanent one.
  ///
  /// A cool-off is irreversible for its whole term, so a mis-tap costs a player a day or a
  /// month. The friction is the same shape as the server's `confirm` field, and neither is
  /// trusted by the other: this stops an accident, and the server's copy stops a request
  /// that never came from this screen at all.
  Future<void> _start(
    BuildContext context,
    WidgetRef ref, {
    required String kind,
    required int? durationMs,
    required String title,
    required String message,
  }) async {
    final controller = TextEditingController();
    final t = context.tokens;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: t.colors.surface,
        title: Text(title, style: t.text.titleMedium.copyWith(color: t.colors.textPrimary)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message, style: t.text.body.copyWith(color: t.colors.textSecondary)),
            SizedBox(height: t.space.md),
            AppInput(label: 'Confirmation', controller: controller),
          ],
        ),
        actions: [
          AppButton(
            label: 'Cancel',
            variant: AppButtonVariant.ghost,
            onPressed: () => Navigator.of(dialogContext).pop(false),
          ),
          AppButton(
            label: 'Confirm',
            variant: AppButtonVariant.danger,
            onPressed: () =>
                Navigator.of(dialogContext).pop(controller.text.trim() == _confirmPhrase),
          ),
        ],
      ),
    );

    if (confirmed != true || !context.mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiClientProvider).startRgExclusion(
        kind: kind,
        durationMs: durationMs,
        confirm: _confirmPhrase,
      );
      ref.invalidate(rgStatusProvider);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on NetworkException {
      messenger.showSnackBar(
        const SnackBar(content: Text('Cannot reach the server. Nothing was changed.')),
      );
    }
  }
}

class _HistorySection extends StatelessWidget {
  const _HistorySection({required this.status});

  final RgStatus status;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Your record', style: t.text.label.copyWith(color: t.colors.textSecondary)),
        SizedBox(height: t.space.sm),
        if (status.events.isEmpty)
          const AppEmptyState(
            title: 'Nothing here yet',
            message: 'Limits you set and breaks you take are listed here.',
          )
        else
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final event in status.events) ...[
                  Text(
                    _describe(event),
                    style: t.text.bodySmall.copyWith(color: t.colors.textPrimary),
                  ),
                  Text(
                    _formatDateTime(event.at),
                    style: t.text.bodySmall.copyWith(color: t.colors.textSecondary),
                  ),
                  SizedBox(height: t.space.sm),
                ],
              ],
            ),
          ),
      ],
    );
  }

  static String _describe(RgEvent event) => switch (event.type) {
    'limit.set' => 'Limit set',
    'limit.increase_requested' => 'Higher limit requested',
    'limit.increase_cancelled' => 'Higher limit cancelled',
    'limit.increase_applied' => 'Higher limit took effect',
    'cool_off.started' => 'Break started',
    'self_exclusion.started' => 'Self-exclusion started',
    'exclusion.lapsed' => 'Break ended',
    'reality_check.shown' => 'Reality check shown',
    'reality_check.acknowledged' => 'Reality check acknowledged',
    'reality_check.interval_set' => 'Reality check interval changed',
    _ => event.type,
  };
}

/// Minor units to a plain amount. Display only — no arithmetic on money happens here
/// beyond turning the server's integer into the string a person reads (rule 4).
String _money(int minorUnits) => '${(minorUnits / 100).toStringAsFixed(2)} TST';

String _two(int value) => value.toString().padLeft(2, '0');

String _formatDate(DateTime value) {
  final local = value.toLocal();
  return '${local.year}-${_two(local.month)}-${_two(local.day)}';
}

String _formatDateTime(DateTime value) {
  final local = value.toLocal();
  return '${_formatDate(value)} ${_two(local.hour)}:${_two(local.minute)}';
}
