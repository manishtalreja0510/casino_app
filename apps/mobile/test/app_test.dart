import 'package:api_client/api_client.dart';
import 'package:casino_app/app/app.dart';
import 'package:casino_app/app/providers.dart';
import 'package:casino_app/config/app_config.dart';
import 'package:casino_app/features/auth/auth_controller.dart';
import 'package:casino_app/features/auth/auth_state.dart';
import 'package:casino_app/features/wallet/wallet_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ui_kit/ui_kit.dart';

import 'fakes.dart';

Widget appWith(List<Override> overrides, {AuthState auth = const AuthState.signedOut()}) =>
    ProviderScope(
      overrides: [
        appConfigProvider.overrideWithValue(AppConfig.forTesting()),
        authControllerProvider.overrideWith((ref) => FakeAuthController(auth)),
        connectivityProvider.overrideWith((ref) => Stream.value(true)),
        serverReachabilityProvider.overrideWith((ref) async => HealthStatus.ok),
        balanceProvider.overrideWith(
          (ref) async => const Money(amount: 0, currency: Money.testCurrency),
        ),
        ...overrides,
      ],
      child: const CasinoApp(),
    );

const _user = AuthUser(
  id: '018f2b1c-0000-7000-8000-000000000000',
  email: 'player@example.test',
  displayName: 'Player One',
  status: 'active',
  kycLevel: 'L0',
);

void main() {
  group('auth gate', () {
    testWidgets('shows the restoring screen while the session is unresolved', (tester) async {
      await tester.pumpWidget(appWith(const [], auth: const AuthState.unknown()));
      await tester.pump();
      // A cold start must not flash the login screen at an already-signed-in player.
      expect(find.textContaining('Restoring session'), findsOneWidget);
    });

    testWidgets('sends an unauthenticated user to sign-in', (tester) async {
      await tester.pumpWidget(appWith(const []));
      await tester.pumpAndSettle();
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Create an account'), findsOneWidget);
    });

    testWidgets('surfaces an involuntary sign-out reason', (tester) async {
      await tester.pumpWidget(appWith(
        const [],
        auth: const AuthState.signedOut(
          failure: 'Your session was ended for security reasons. Please sign in again.',
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(AppBanner), findsOneWidget);
      expect(find.textContaining('security reasons'), findsOneWidget);
    });

    testWidgets('lets an authenticated user reach home', (tester) async {
      await tester.pumpWidget(appWith(const [], auth: const AuthState.signedIn(_user)));
      await tester.pumpAndSettle();
      expect(find.text('casino_app dev'), findsOneWidget);
      expect(find.text('DEV'), findsOneWidget);
    });
  });

  group('home screen', () {
    testWidgets('shows an offline banner when connectivity drops', (tester) async {
      await tester.pumpWidget(appWith(
        [connectivityProvider.overrideWith((ref) => Stream.value(false))],
        auth: const AuthState.signedIn(_user),
      ));
      await tester.pumpAndSettle();
      expect(find.textContaining('offline'), findsOneWidget);
    });

    testWidgets('distinguishes an unreachable server from being offline', (tester) async {
      await tester.pumpWidget(appWith(
        [serverReachabilityProvider.overrideWith((ref) async => HealthStatus.down)],
        auth: const AuthState.signedIn(_user),
      ));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cannot reach the server'), findsOneWidget);
    });

    testWidgets('renders a zero balance from integer minor units', (tester) async {
      await tester.pumpWidget(appWith(const [], auth: const AuthState.signedIn(_user)));
      await tester.pumpAndSettle();
      expect(find.text('0.00 TST'), findsOneWidget);
    });

    testWidgets('hides the developer gallery entry in production builds', (tester) async {
      await tester.pumpWidget(appWith(
        [
          appConfigProvider.overrideWithValue(
            AppConfig.forTesting(
              flavor: Flavor.prod,
              apiBaseUrl: 'https://api.example.invalid/api/v1',
            ),
          ),
        ],
        auth: const AuthState.signedIn(_user),
      ));
      await tester.pumpAndSettle();
      expect(find.text('Component gallery'), findsNothing);
    });
  });
}
