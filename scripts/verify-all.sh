#!/usr/bin/env bash
# Full local verification — the release gate while GitHub Actions is disabled.
# Runs exactly what CI ran (.github/workflows/ci.yml.disabled), locally and for free.
#
#   pnpm verify:all
set -uo pipefail

cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgresql://casino_dev:casino_dev_local_only@127.0.0.1:5432/casino_dev}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

FAILURES=()
step() {
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$name"
  else
    printf '\033[31m✘ %s\033[0m\n' "$name"
    FAILURES+=("$name")
  fi
}

# Datastores must be up: integration tests run against a real PostgreSQL and Redis,
# never a mock (testing-strategy.md).
if ! pg_isready -q 2>/dev/null || ! redis-cli ping >/dev/null 2>&1; then
  echo "Starting local dev services…"
  bash scripts/dev-services.sh start || true
fi

step "lint"                pnpm lint
step "typecheck"           pnpm typecheck
step "unit tests"          pnpm test
step "build"               pnpm build
step "migrations"          pnpm --filter @casino/api migrate
step "integration tests"   pnpm --filter @casino/api test:int

# Flutter lanes run only once the app exists (P2) and the SDK is present.
if [ -f apps/mobile/pubspec.yaml ] && command -v flutter >/dev/null 2>&1; then
  step "flutter analyze"   bash -c "cd apps/mobile && flutter analyze"
  step "flutter test"      bash -c "cd apps/mobile && flutter test"
fi

# Secret scanning (rule 14). gitleaks is optional locally; note loudly when absent.
if command -v gitleaks >/dev/null 2>&1; then
  step "secret scan"       gitleaks detect --config .gitleaks.toml --no-banner
else
  printf '\n\033[33m⚠ secret scan SKIPPED — gitleaks not installed.\033[0m\n'
  printf '  Install it (https://github.com/gitleaks/gitleaks) or re-enable CI before a release.\n'
fi

printf '\n────────────────────────────\n'
if [ ${#FAILURES[@]} -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILURES[*]}"
printf 'Do not push until these pass (rule 18).\n'
exit 1
