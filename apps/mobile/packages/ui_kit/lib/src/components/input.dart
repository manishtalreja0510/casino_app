import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// Text input with label, hint and error state.
///
/// Client-side validation here is UX only: the server re-validates everything and is the
/// authority on whether an input is acceptable (rule 21).
class AppInput extends StatelessWidget {
  const AppInput({
    super.key,
    required this.label,
    this.controller,
    this.hint,
    this.errorText,
    this.obscure = false,
    this.enabled = true,
    this.keyboardType,
    this.onChanged,
    this.onSubmitted,
    this.autofillHints,
    this.inputFormatters,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final String? errorText;
  final bool obscure;
  final bool enabled;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final Iterable<String>? autofillHints;

  /// Keystroke-level restrictions (digits only for a stake, say). **UX, not validation** —
  /// the server re-checks every value and is the only thing that can accept one.
  final List<TextInputFormatter>? inputFormatters;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final hasError = errorText != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: t.text.label.copyWith(color: t.colors.textSecondary)),
        SizedBox(height: t.space.xs),
        TextField(
          controller: controller,
          obscureText: obscure,
          enabled: enabled,
          keyboardType: keyboardType,
          inputFormatters: inputFormatters,
          onChanged: onChanged,
          onSubmitted: onSubmitted,
          autofillHints: autofillHints,
          style: t.text.body.copyWith(color: enabled ? t.colors.textPrimary : t.colors.textDisabled),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: t.text.body.copyWith(color: t.colors.textDisabled),
            filled: true,
            fillColor: t.colors.surface,
            contentPadding: EdgeInsets.symmetric(horizontal: t.space.md, vertical: t.space.md),
            enabledBorder: _border(t.colors.border, t.space.radiusMd, t.space.borderWidth),
            focusedBorder: _border(t.colors.primary, t.space.radiusMd, t.space.borderWidth),
            errorBorder: _border(t.colors.danger, t.space.radiusMd, t.space.borderWidth),
            focusedErrorBorder: _border(t.colors.danger, t.space.radiusMd, t.space.borderWidth),
            disabledBorder: _border(t.colors.border, t.space.radiusMd, t.space.borderWidth),
          ),
        ),
        if (hasError) ...[
          SizedBox(height: t.space.xs),
          Text(errorText!, style: t.text.bodySmall.copyWith(color: t.colors.danger)),
        ],
      ],
    );
  }

  OutlineInputBorder _border(Color color, double radius, double width) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: color, width: width),
      );
}
