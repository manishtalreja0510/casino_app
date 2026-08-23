import 'package:casino_app/config/app_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Flavor', () {
    test('parses the three known flavors', () {
      expect(Flavor.parse('dev'), Flavor.dev);
      expect(Flavor.parse('staging'), Flavor.staging);
      expect(Flavor.parse('prod'), Flavor.prod);
    });

    test('REFUSES an unknown flavor rather than guessing', () {
      // Guessing here could point a build at the wrong backend — the one mistake this
      // config system exists to prevent.
      expect(() => Flavor.parse('production'), throwsArgumentError);
      expect(() => Flavor.parse(''), throwsArgumentError);
    });
  });

  group('AppConfig', () {
    test('marks non-production builds with a visible badge', () {
      expect(AppConfig.forTesting(flavor: Flavor.dev).environmentBadge, 'DEV');
      expect(AppConfig.forTesting(flavor: Flavor.staging).environmentBadge, 'STAGING');
      // Never in production: a badge there would be a bug, not a safeguard.
      expect(AppConfig.forTesting(flavor: Flavor.prod).environmentBadge, isNull);
    });

    test('fromEnvironment throws when the build carried no configuration', () {
      // Tests run without --dart-define-from-file, which is exactly the failure case:
      // a client that does not know its backend must not start.
      expect(AppConfig.fromEnvironment, throwsStateError);
    });

    test('the three example configs describe three distinct environments', () {
      final dev = AppConfig.forTesting(flavor: Flavor.dev, apiBaseUrl: 'http://10.0.2.2:3000/api/v1');
      final staging = AppConfig.forTesting(
        flavor: Flavor.staging,
        apiBaseUrl: 'https://staging-api.example.invalid/api/v1',
      );
      final prod = AppConfig.forTesting(
        flavor: Flavor.prod,
        apiBaseUrl: 'https://api.example.invalid/api/v1',
      );

      expect({dev.apiBaseUrl, staging.apiBaseUrl, prod.apiBaseUrl}, hasLength(3));
      expect(dev.flavor.isProduction, isFalse);
      expect(prod.flavor.isProduction, isTrue);
    });
  });
}
