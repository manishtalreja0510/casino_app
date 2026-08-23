import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ui_kit/ui_kit.dart';

import '../../app/providers.dart';
import 'auth_controller.dart';

/// Sign in / create account.
///
/// A thin shell (rule 21): it collects input, calls the controller, and renders whatever
/// the server said. Client-side checks here are UX only — every rule is enforced again
/// server-side, and the server's answer is the one that counts.
class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _displayName = TextEditingController();

  bool _registering = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _displayName.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    final controller = ref.read(authControllerProvider.notifier);
    final failure = _registering
        ? await controller.register(
            email: _email.text,
            password: _password.text,
            displayName: _displayName.text,
          )
        : await controller.login(email: _email.text, password: _password.text);

    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final config = ref.watch(appConfigProvider);
    final involuntarySignOut = ref.watch(authControllerProvider).failure;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: EdgeInsets.all(t.space.lg),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    config.appName,
                    textAlign: TextAlign.center,
                    style: t.text.display.copyWith(color: t.colors.textPrimary),
                  ),
                  if (config.environmentBadge != null) ...[
                    SizedBox(height: t.space.xs),
                    Text(
                      config.environmentBadge!,
                      textAlign: TextAlign.center,
                      style: t.text.label.copyWith(color: t.colors.warning),
                    ),
                  ],
                  SizedBox(height: t.space.xl),

                  if (involuntarySignOut != null) ...[
                    AppBanner(
                      message: involuntarySignOut,
                      tone: AppBannerTone.warning,
                      icon: Icons.shield_outlined,
                    ),
                    SizedBox(height: t.space.md),
                  ],

                  if (_registering) ...[
                    AppInput(
                      label: 'Display name',
                      controller: _displayName,
                      hint: 'Shown at the table',
                    ),
                    SizedBox(height: t.space.md),
                  ],
                  AppInput(
                    label: 'Email',
                    controller: _email,
                    hint: 'you@example.com',
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                  ),
                  SizedBox(height: t.space.md),
                  AppInput(
                    label: 'Password',
                    controller: _password,
                    obscure: true,
                    hint: _registering ? 'At least 12 characters' : null,
                    autofillHints: const [AutofillHints.password],
                    onSubmitted: (_) => _submit(),
                  ),

                  if (_error != null) ...[
                    SizedBox(height: t.space.md),
                    AppBanner(message: _error!, tone: AppBannerTone.danger, icon: Icons.error_outline),
                  ],

                  SizedBox(height: t.space.lg),
                  AppButton(
                    label: _registering ? 'Create account' : 'Sign in',
                    expand: true,
                    loading: _busy,
                    onPressed: _busy ? null : _submit,
                  ),
                  SizedBox(height: t.space.sm),
                  AppButton(
                    label: _registering ? 'I already have an account' : 'Create an account',
                    variant: AppButtonVariant.ghost,
                    expand: true,
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                            _registering = !_registering;
                            _error = null;
                          }),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shown while a saved session is being restored, so a cold start does not flash the
/// login screen at an already-signed-in player.
class AuthLoadingScreen extends StatelessWidget {
  const AuthLoadingScreen({super.key});

  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: AppLoadingState(message: 'Restoring session…'));
}
