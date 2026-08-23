import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/auth_controller.dart';
import '../features/auth/auth_screen.dart';
import '../features/auth/auth_state.dart';
import '../features/gallery/gallery_screen.dart';
import '../features/home/home_screen.dart';
import '../features/wallet/wallet_screen.dart';

/// Central route configuration — flow as configuration (ADR-002, `ui-flow-map.md`).
///
/// Every screen is named here, so the designer-approved flow (P19) can reorder screens
/// by editing this file rather than by touching screens.
class AppRoutes {
  const AppRoutes._();

  static const String home = '/';
  static const String signIn = '/sign-in';
  static const String starting = '/starting';
  static const String wallet = '/wallet';
  static const String gallery = '/_dev/gallery';
}

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: AppRoutes.starting,
    refreshListenable: _AuthListenable(ref),
    // The single place that decides what an unauthenticated user may see. Screens never
    // check auth themselves, so a new screen is gated by default rather than by memory.
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final location = state.matchedLocation;

      if (!auth.isResolved) {
        return location == AppRoutes.starting ? null : AppRoutes.starting;
      }
      if (!auth.isAuthenticated) {
        return location == AppRoutes.signIn ? null : AppRoutes.signIn;
      }
      if (location == AppRoutes.signIn || location == AppRoutes.starting) {
        return AppRoutes.home;
      }
      return null;
    },
    routes: [
      GoRoute(
        path: AppRoutes.starting,
        name: 'starting',
        builder: (context, state) => const AuthLoadingScreen(),
      ),
      GoRoute(
        path: AppRoutes.signIn,
        name: 'signIn',
        builder: (context, state) => const AuthScreen(),
      ),
      GoRoute(
        path: AppRoutes.home,
        name: 'home',
        builder: (context, state) => const HomeScreen(),
      ),
      GoRoute(
        path: AppRoutes.wallet,
        name: 'wallet',
        builder: (context, state) => const WalletScreen(),
      ),
      GoRoute(
        // Developer-facing component gallery: the proof that every component renders
        // from tokens alone, and the designer's reference in P19.
        path: AppRoutes.gallery,
        name: 'gallery',
        builder: (context, state) => const GalleryScreen(),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(child: Text('Route not found: ${state.uri}')),
    ),
  );
});

/// Bridges Riverpod auth state to go_router's refresh mechanism, so a sign-in or an
/// involuntary sign-out re-evaluates the redirect immediately.
class _AuthListenable extends ChangeNotifier {
  _AuthListenable(Ref ref) {
    ref.listen<AuthState>(authControllerProvider, (_, __) => notifyListeners());
  }
}
