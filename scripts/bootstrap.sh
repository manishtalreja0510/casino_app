#!/usr/bin/env bash
# One-command bootstrap for a fresh clone (P0). Creates local env files from the
# committed .example templates — real .env files are gitignored (rule 14).
set -euo pipefail

for example in .env.example apps/api/.env.example; do
  target="${example%.example}"
  if [ -f "$example" ] && [ ! -f "$target" ]; then
    cp "$example" "$target"
    echo "created $target from $example"
  fi
done

echo "Installing workspace dependencies"
pnpm install

cat <<'NEXT'

Bootstrap complete. Next:
  pnpm dev:services     start local Postgres + Redis (free, loopback only)
                        or: docker compose -f infra/docker-compose.dev.yml up -d
  pnpm verify           lint + typecheck + test + build
  pnpm --filter @casino/api start:dev
NEXT
