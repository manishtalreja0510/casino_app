/// Build-time configuration, supplied by `--dart-define-from-file` (ADR-012).
///
/// **This is not secret storage.** Everything here ships inside the APK and is readable
/// by anyone who unzips it (rule 14) — only endpoints and non-sensitive switches belong
/// here. Secrets live server-side, in the secret manager, and never reach the client.
enum Flavor {
  dev,
  staging,
  prod;

  static Flavor parse(String value) => switch (value) {
        'dev' => Flavor.dev,
        'staging' => Flavor.staging,
        'prod' => Flavor.prod,
        // An unrecognised flavor must not silently become production or development.
        _ => throw ArgumentError(
            'Unknown flavor "$value". Expected dev, staging or prod — check the '
            '--dart-define-from-file argument.',
          ),
      };

  bool get isProduction => this == Flavor.prod;
}

class AppConfig {
  const AppConfig({
    required this.flavor,
    required this.apiBaseUrl,
    required this.appName,
  });

  final Flavor flavor;

  /// Full REST base including the version prefix, e.g. `https://api.example.com/api/v1`.
  final String apiBaseUrl;

  final String appName;

  /// Reads the compile-time environment.
  ///
  /// Missing or malformed configuration throws rather than defaulting: a build that
  /// does not know which environment it targets must fail loudly at startup, not point
  /// a "staging" build at production (or vice versa).
  factory AppConfig.fromEnvironment() {
    const flavorName = String.fromEnvironment('FLAVOR');
    const apiBaseUrl = String.fromEnvironment('API_BASE_URL');
    const appName = String.fromEnvironment('APP_NAME');

    if (flavorName.isEmpty || apiBaseUrl.isEmpty) {
      throw StateError(
        'Missing build configuration. Run with '
        '--dart-define-from-file=config/<flavor>.json (see config/*.example.json).',
      );
    }

    final flavor = Flavor.parse(flavorName);

    // Cleartext is acceptable only for local development. Shipping a staging or
    // production build that talks plain HTTP would silently disable transport security.
    if (flavor != Flavor.dev && !apiBaseUrl.startsWith('https://')) {
      throw StateError('API_BASE_URL must use https for the ${flavor.name} flavor.');
    }

    return AppConfig(
      flavor: flavor,
      apiBaseUrl: apiBaseUrl,
      appName: appName.isEmpty ? 'casino_app' : appName,
    );
  }

  /// Build a config explicitly — for tests, which must not depend on dart-defines.
  factory AppConfig.forTesting({
    Flavor flavor = Flavor.dev,
    String apiBaseUrl = 'http://127.0.0.1:3000/api/v1',
    String appName = 'casino_app dev',
  }) =>
      AppConfig(flavor: flavor, apiBaseUrl: apiBaseUrl, appName: appName);

  /// Shown in dev and staging builds so a tester can never mistake which backend they
  /// are hitting. Never shown in production.
  String? get environmentBadge => flavor.isProduction ? null : flavor.name.toUpperCase();
}
