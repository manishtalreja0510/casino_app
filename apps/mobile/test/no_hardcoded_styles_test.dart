import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Rule 25 as an executable check.
///
/// Screens must not hardcode colours, font sizes, radii or spacing — everything comes
/// from tokens and `ui_kit`, which is what makes the P19 restyle a restyle rather than a
/// rewrite (ADR-019). Review alone does not hold a rule like this over years; this test
/// does. `ui_kit`'s own token files are the one legitimate home for raw values and are
/// therefore not scanned.
void main() {
  test('no screen or feature file hardcodes a style value', () {
    final offenders = <String>[];

    final forbidden = <RegExp, String>{
      RegExp(r'Color\(0x[0-9a-fA-F]{8}\)'): 'raw Color literal — use context.tokens.colors',
      RegExp(r'Colors\.[a-zA-Z]+'): 'Material Colors palette — use context.tokens.colors',
      RegExp(r'fontSize:\s*\d'): 'raw fontSize — use context.tokens.text',
      RegExp(r'BorderRadius\.circular\(\s*\d'): 'raw radius — use context.tokens.space',
      RegExp(r'EdgeInsets\.(all|symmetric|only)\([^)]*\d+(\.\d+)?\s*[,)]'):
          'raw spacing — use context.tokens.space',
    };

    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final source = entity.readAsStringSync();

      for (final entry in forbidden.entries) {
        for (final match in entry.key.allMatches(source)) {
          final line = source.substring(0, match.start).split('\n').length;
          offenders.add('${entity.path}:$line — ${entry.value} (${match.group(0)})');
        }
      }
    }

    expect(
      offenders,
      isEmpty,
      reason: 'Hardcoded style values found (rule 25):\n${offenders.join('\n')}',
    );
  });
}
