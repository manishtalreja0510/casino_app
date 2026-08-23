# Build-time configuration

`--dart-define-from-file=config/<flavor>.json` supplies the app's compile-time config.

- `*.example.json` are committed templates.
- `dev.json` / `staging.json` / `prod.json` are **gitignored** — copy from the templates.
- **Nothing secret goes here.** Everything in these files ends up inside the APK and is
  readable by anyone who unzips it (rule 14). Endpoints and non-sensitive switches only.

```bash
flutter run          --dart-define-from-file=config/dev.json --flavor dev
flutter build apk    --dart-define-from-file=config/prod.json --flavor prod \
                     --obfuscate --split-debug-info=build/symbols/prod
```
