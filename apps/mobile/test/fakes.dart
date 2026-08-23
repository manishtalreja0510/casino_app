import 'package:api_client/api_client.dart';
import 'package:casino_app/features/auth/auth_controller.dart';
import 'package:casino_app/features/auth/auth_state.dart';
import 'package:casino_app/features/auth/token_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Auth controller pinned to a state, for widget tests that exercise the gate rather
/// than the network.
class FakeAuthController extends AuthController {
  FakeAuthController(AuthState initial)
    : super(
        client: CasinoApiClient(baseUrl: 'http://127.0.0.1:0/api/v1'),
        store: TokenStore(const FlutterSecureStorage()),
      ) {
    state = initial;
  }

  @override
  Future<void> restore() async {}
}
