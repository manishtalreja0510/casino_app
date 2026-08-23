import 'dart:io';

import 'package:app_assets/app_assets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('asset registry', () {
    test('every registered asset exists on disk', () {
      // A missing asset must break the build, not appear as a blank square mid-game
      // (asset-animation-pipeline.md).
      final missing = <String>[];
      for (final path in allRegisteredAssets) {
        final file = File('packages/assets/$path');
        if (!file.existsSync()) missing.add(path);
      }
      expect(missing, isEmpty, reason: 'missing placeholder assets: $missing');
    });

    test('paths follow the final naming convention', () {
      // The names are final now so P19 drops designed files in under the same names and
      // no call site changes.
      final pattern = RegExp(r'^assets/(images|icons|animations|audio)/[a-z]+/(img|ic|anim|sfx)_[a-z0-9_]+\.[a-z0-9]+$');
      for (final path in allRegisteredAssets) {
        expect(pattern.hasMatch(path), isTrue, reason: '$path does not follow the convention');
      }
    });

    test('prefix matches the asset kind', () {
      for (final path in allRegisteredAssets) {
        if (path.startsWith('assets/images/')) expect(path, contains('/img_'));
        if (path.startsWith('assets/icons/')) expect(path, contains('/ic_'));
        if (path.startsWith('assets/animations/')) expect(path, contains('/anim_'));
        if (path.startsWith('assets/audio/')) expect(path, contains('/sfx_'));
      }
    });

    test('registry has no duplicates', () {
      expect(allRegisteredAssets.toSet().length, allRegisteredAssets.length);
    });
  });
}
