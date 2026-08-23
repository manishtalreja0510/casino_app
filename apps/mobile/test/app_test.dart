import 'package:api_client/api_client.dart';
import 'package:casino_app/app/app.dart';
import 'package:casino_app/app/providers.dart';
import 'package:casino_app/config/app_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ui_kit/ui_kit.dart';

Widget appWith(List<Override> overrides) => ProviderScope(
      overrides: [
        appConfigProvider.overrideWithValue(AppConfig.forTesting()),
        ...overrides,
      ],
      child: const CasinoApp(),
    );

void main() {
  group('app shell', () {
    testWidgets('renders the home screen with the placeholder theme', (tester) async {
      await tester.pumpWidget(appWith([
        serverReachabilityProvider.overrideWith((ref) async => HealthStatus.ok),
        connectivityProvider.overrideWith((ref) => Stream.value(true)),
      ]));
      await tester.pumpAndSettle();

      expect(find.text('casino_app dev'), findsOneWidget);
      // Non-production builds are badged so a tester cannot mistake the backend.
      expect(find.text('DEV'), findsOneWidget);
    });

    testWidgets('shows an offline banner when connectivity drops', (tester) async {
      await tester.pumpWidget(appWith([
        connectivityProvider.overrideWith((ref) => Stream.value(false)),
        serverReachabilityProvider.overrideWith((ref) async => HealthStatus.ok),
      ]));
      await tester.pumpAndSettle();

      expect(find.byType(AppBanner), findsOneWidget);
      expect(find.textContaining('offline'), findsOneWidget);
    });

    testWidgets('distinguishes an unreachable server from being offline', (tester) async {
      await tester.pumpWidget(appWith([
        connectivityProvider.overrideWith((ref) => Stream.value(true)),
        serverReachabilityProvider.overrideWith((ref) async => HealthStatus.down),
      ]));
      await tester.pumpAndSettle();

      // "You are offline" would be a lie when the device has a network and the backend
      // is the thing that is down.
      expect(find.textContaining('Cannot reach the server'), findsOneWidget);
    });

    testWidgets('renders a zero balance from integer minor units, never computed locally',
        (tester) async {
      await tester.pumpWidget(appWith([
        connectivityProvider.overrideWith((ref) => Stream.value(true)),
        serverReachabilityProvider.overrideWith((ref) async => HealthStatus.ok),
      ]));
      await tester.pumpAndSettle();
      expect(find.text('0.00 TST'), findsOneWidget);
    });

    testWidgets('hides the developer gallery entry in production builds', (tester) async {
      await tester.pumpWidget(ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(
            AppConfig.forTesting(flavor: Flavor.prod, apiBaseUrl: 'https://api.example.invalid/api/v1'),
          ),
          connectivityProvider.overrideWith((ref) => Stream.value(true)),
          serverReachabilityProvider.overrideWith((ref) async => HealthStatus.ok),
        ],
        child: const CasinoApp(),
      ));
      await tester.pumpAndSettle();
      expect(find.text('Component gallery'), findsNothing);
    });
  });
}
