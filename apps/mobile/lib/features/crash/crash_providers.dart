import 'dart:async';

import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/realtime_providers.dart';

/// What the Crash screen renders.
///
/// Every field is either something the server said or something purely cosmetic. There is
/// no field here the client decided: not whether a bet was accepted, not what a cash-out
/// is worth, not whether the round is over (rules 1, 21).
class CrashViewState {
  const CrashViewState({
    this.round,
    this.drawnMultiplierX100 = 100,
    this.busy = false,
    this.message,
    this.error,
  });

  final CrashRound? round;

  /// The multiplier being *drawn* right now — the server's last value, extrapolated along
  /// the curve the server described. Never used to compute money.
  final int drawnMultiplierX100;

  /// A request is in flight; the buttons are disabled so a double tap cannot double-bet.
  final bool busy;

  /// The server's last word to the player — a rejection reason, a settled payout.
  final String? message;

  final Object? error;

  bool get isLoading => round == null && error == null;

  CrashViewState copyWith({
    CrashRound? round,
    int? drawnMultiplierX100,
    bool? busy,
    String? message,
    Object? error,
    bool clearMessage = false,
    bool clearError = false,
  }) => CrashViewState(
    round: round ?? this.round,
    drawnMultiplierX100: drawnMultiplierX100 ?? this.drawnMultiplierX100,
    busy: busy ?? this.busy,
    message: clearMessage ? null : (message ?? this.message),
    error: clearError ? null : (error ?? this.error),
  );
}

/// Drives one tier's Crash screen.
///
/// It does three things: ask the server for the round, listen for what happens to it, and
/// forward the player's intent. The rising number is animated locally because no server
/// pushes ten updates a second — but every server message overwrites it, and the number is
/// never turned into a payout.
class CrashController extends StateNotifier<CrashViewState> {
  CrashController(this._ref, this._tierId) : super(const CrashViewState()) {
    unawaited(_load());
    _listen();
    _ticker = Timer.periodic(const Duration(milliseconds: 100), (_) => _draw());
  }

  final Ref _ref;
  final String _tierId;
  Timer? _ticker;
  ProviderSubscription<AsyncValue<RealtimeEvent>>? _subscription;

  CasinoApiClient get _api => _ref.read(apiClientProvider);

  Future<void> refresh() => _load();

  Future<void> _load() async {
    try {
      final round = await _api.crashRound(_tierId);
      if (!mounted) return;
      state = state.copyWith(round: round, clearError: true);
      _draw();
    } catch (error) {
      if (!mounted) return;
      state = state.copyWith(error: error);
    }
  }

  void _listen() {
    _subscription = _ref.listen<AsyncValue<RealtimeEvent>>(
      roomEventsProvider(CrashRound.roomFor(_tierId)),
      (_, next) {
        // A realtime failure is not fatal: the screen still works by asking the server,
        // which is what re-reading the round on every event already does.
        next.when(
          data: _apply,
          error: (_, __) => unawaited(_load()),
          loading: () {},
        );
      },
    );
  }

  /// Applies a round-lifecycle event.
  ///
  /// Deliberately conservative: an event tells the screen that *something happened*, and
  /// the authoritative shape of the round is then re-read from the server. Reconstructing
  /// round state from a stream of deltas would mean the client holding an opinion about
  /// the round, which is exactly what it must not do.
  void _apply(RealtimeEvent event) {
    if (event.type == 'round:crashed') {
      state = state.copyWith(
        message: 'Crashed at ${formatMultiplier(event.payload['crashedAtX100'] as int? ?? 100)}',
      );
    }
    unawaited(_load());
  }

  /// Advances the drawn multiplier. Cosmetic only — see [CrashRound.drawnMultiplierAt].
  void _draw() {
    final round = state.round;
    if (round == null || !mounted) return;

    if (round.phase == CrashPhase.crashed) {
      state = state.copyWith(drawnMultiplierX100: round.crashedAtX100 ?? round.multiplierX100);
      return;
    }
    if (round.phase != CrashPhase.flying || round.startedAt == null) {
      state = state.copyWith(drawnMultiplierX100: 100);
      return;
    }

    state = state.copyWith(
      drawnMultiplierX100: round.drawnMultiplierAt(DateTime.now().difference(round.startedAt!)),
    );
  }

  Future<void> placeBet({required int amountMinorUnits, int? autoCashOutX100}) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearMessage: true);
    try {
      final result = await _api.placeCrashBet(
        _tierId,
        amountMinorUnits: amountMinorUnits,
        autoCashOutX100: autoCashOutX100,
      );
      if (!mounted) return;
      state = state.copyWith(busy: false, message: 'Bet placed: ${result.amount.format()}');
      await _load();
    } on ApiException catch (error) {
      // Bounds, caps, a closed window, insufficient funds — all decided server-side, and
      // all reported in its words rather than guessed at here.
      if (mounted) state = state.copyWith(busy: false, message: error.message);
    } on NetworkException {
      if (mounted) state = state.copyWith(busy: false, message: 'Cannot reach the server.');
    }
  }

  Future<void> cashOut() async {
    final round = state.round;
    if (round == null || state.busy) return;

    state = state.copyWith(busy: true, clearMessage: true);
    try {
      final result = await _api.crashCashOut(round.matchId);
      if (!mounted) return;
      state = state.copyWith(
        busy: false,
        message:
            'Cashed out at ${formatMultiplier(result.cashedOutAtX100)} for ${result.payout.format()}',
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) state = state.copyWith(busy: false, message: error.message);
    } on NetworkException {
      if (mounted) state = state.copyWith(busy: false, message: 'Cannot reach the server.');
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _subscription?.close();
    super.dispose();
  }
}

String formatMultiplier(int multiplierX100) => '${(multiplierX100 / 100).toStringAsFixed(2)}x';

final crashControllerProvider =
    StateNotifierProvider.family<CrashController, CrashViewState, String>(
      (ref, tierId) => CrashController(ref, tierId),
    );
