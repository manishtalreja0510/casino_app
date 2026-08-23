/// Typed client for the casino_app REST API.
///
/// Mirrors `packages/contracts` — money as integer minor units, the shared error-code
/// registry, and the `{ error: { … } }` envelope. Nothing here decides anything: the
/// server owns every outcome, balance and timer (rules 1–2).
library;

export 'src/api_client_base.dart';
export 'src/api_error.dart';
export 'src/auth_models.dart';
export 'src/health.dart';
export 'src/lobby_models.dart';
export 'src/money.dart';
export 'src/realtime_client.dart';
export 'src/wallet_models.dart';
