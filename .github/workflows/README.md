# CI workflows — DISABLED

`ci.yml.disabled` is the full CI pipeline (lint, typecheck, unit tests, migrations,
integration tests against PostgreSQL + Redis service containers, gitleaks secret scan,
dependency audit). It is **intentionally disabled**: GitHub Actions minutes are close to
the account limit, so verification runs locally instead.

GitHub only executes workflow files ending in `.yml`/`.yaml` directly inside
`.github/workflows/`, so the `.disabled` suffix keeps the file intact and reviewable
while guaranteeing it never consumes minutes.

## Re-enabling

```bash
git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml
```

Nothing else needs changing — the pipeline is current and was last green on run
`32642623076` (P1).

## What replaces it meanwhile

**`pnpm verify:all` is the gate.** It runs the same checks the pipeline did, against the
local stack (`scripts/verify-all.sh`). Every change must pass it before being pushed —
the standard has not been lowered, only the place it runs. Rule 18 still applies: no
change ships with failing tests.
