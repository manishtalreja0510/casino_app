import 'dart:async';

import 'package:api_client/api_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/realtime_providers.dart';

/// What the poker table screen renders.
class PokerViewState {
  const PokerViewState({this.table, this.busy = false, this.message, this.error});

  final PokerTable? table;
  final bool busy;
  final String? message;
  final Object? error;

  bool get isLoading => table == null && error == null;

  PokerViewState copyWith({
    PokerTable? table,
    bool? busy,
    String? message,
    Object? error,
    bool clearMessage = false,
    bool clearError = false,
  }) => PokerViewState(
    table: table ?? this.table,
    busy: busy ?? this.busy,
    message: clearMessage ? null : (message ?? this.message),
    error: clearError ? null : (error ?? this.error),
  );
}

final pokerTablesProvider = FutureProvider<List<PokerTableSummary>>((ref) async {
  return ref.watch(apiClientProvider).pokerTables();
});

/// Drives one table.
///
/// Every event from the table room is a signal that something happened, not the new state:
/// the table is then re-read from the server. That matters more here than anywhere else in
/// the app — reconstructing a poker hand from a stream of deltas would mean the client
/// holding an opinion about who is to act and what the pot is, and the server's answer is
/// the only one that can be right.
class PokerController extends StateNotifier<PokerViewState> {
  PokerController(this._ref, this._tableId) : super(const PokerViewState()) {
    unawaited(_load());
    _listen();
  }

  final Ref _ref;
  final String _tableId;
  ProviderSubscription<AsyncValue<RealtimeEvent>>? _subscription;

  CasinoApiClient get _api => _ref.read(apiClientProvider);

  Future<void> refresh() => _load();

  Future<void> _load() async {
    try {
      final table = await _api.pokerTable(_tableId);
      if (!mounted) return;
      state = state.copyWith(table: table, clearError: true);
    } catch (error) {
      if (mounted) state = state.copyWith(error: error);
    }
  }

  void _listen() {
    _subscription = _ref.listen<AsyncValue<RealtimeEvent>>(
      roomEventsProvider(PokerTable.roomFor(_tableId)),
      (_, next) => next.when(
        data: (_) => unawaited(_load()),
        error: (_, __) => unawaited(_load()),
        loading: () {},
      ),
    );
  }

  Future<void> sit(int buyIn) => _guard(() async {
    final table = await _api.sitAtPokerTable(_tableId, buyIn: buyIn);
    if (mounted) state = state.copyWith(table: table, message: 'Seated');
  });

  Future<void> stand() => _guard(() async {
    final table = await _api.standFromPokerTable(_tableId);
    if (mounted) state = state.copyWith(table: table, message: 'Standing up');
  });

  Future<void> act(String type, {int? amount}) => _guard(() async {
    final table = await _api.actAtPokerTable(_tableId, type: type, amount: amount);
    if (mounted) state = state.copyWith(table: table);
  });

  /// Runs a request with the buttons disabled, and reports refusals in the server's words.
  Future<void> _guard(Future<void> Function() work) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearMessage: true);
    try {
      await work();
      if (mounted) state = state.copyWith(busy: false);
    } on ApiException catch (error) {
      if (mounted) state = state.copyWith(busy: false, message: error.message);
    } on NetworkException {
      if (mounted) state = state.copyWith(busy: false, message: 'Cannot reach the server.');
    }
  }

  @override
  void dispose() {
    _subscription?.close();
    super.dispose();
  }
}

final pokerControllerProvider =
    StateNotifierProvider.family<PokerController, PokerViewState, String>(
      (ref, tableId) => PokerController(ref, tableId),
    );
