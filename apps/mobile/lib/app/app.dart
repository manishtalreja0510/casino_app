import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import 'providers.dart';
import 'router.dart';

/// Root widget. Wires the router and the placeholder theme; owns no logic.
class CasinoApp extends ConsumerStatefulWidget {
  const CasinoApp({super.key});

  @override
  ConsumerState<CasinoApp> createState() => _CasinoAppState();
}

class _CasinoAppState extends ConsumerState<CasinoApp> {
  late final router = createRouter();

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);

    return MaterialApp.router(
      title: config.appName,
      debugShowCheckedModeBanner: false,
      // P19 replaces the theme; screens and components are unaffected (ADR-019).
      theme: AppTheme.placeholderDark(),
      routerConfig: router,
    );
  }
}
