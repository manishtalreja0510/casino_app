import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/gallery/gallery_screen.dart';
import '../features/home/home_screen.dart';

/// Central route configuration — flow as configuration (ADR-002, `ui-flow-map.md`).
///
/// Every screen is named here, so the designer-approved flow (P19) can reorder screens
/// by editing this file rather than by touching screens. Route paths are the contract
/// between navigation and screens; screens never construct routes by string literal.
class AppRoutes {
  const AppRoutes._();

  static const String home = '/';
  static const String gallery = '/_dev/gallery';
}

GoRouter createRouter({String initialLocation = AppRoutes.home}) {
  return GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: AppRoutes.home,
        name: 'home',
        builder: (context, state) => const HomeScreen(),
      ),
      GoRoute(
        // Developer-facing component gallery. Not part of the player flow; it is the
        // proof that every component renders from tokens alone, and the designer's
        // reference in P19.
        path: AppRoutes.gallery,
        name: 'gallery',
        builder: (context, state) => const GalleryScreen(),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(child: Text('Route not found: ${state.uri}')),
    ),
  );
}
