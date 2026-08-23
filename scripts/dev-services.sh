#!/usr/bin/env bash
# Native local Postgres + Redis — the documented fallback when the Docker daemon
# is unavailable (ADR-021). Provides the SAME ports as infra/docker-compose.dev.yml
# so the API is indifferent to which path started them.
#
#   pnpm dev:services         # start
#   pnpm dev:services:status  # check
#   pnpm dev:services:stop    # stop
#
# Local-only throwaway credentials; never a template for a real environment.
set -euo pipefail

DB_NAME="${POSTGRES_DB:-casino_dev}"
DB_USER="${POSTGRES_USER:-casino_dev}"
DB_PASSWORD="${POSTGRES_PASSWORD:-casino_dev_local_only}"
REDIS_PORT="${REDIS_PORT:-6379}"
STATE_DIR=".dev-services"

log() { printf '  %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found. Install PostgreSQL 16 and Redis 7, or use Docker:" >&2
    echo "       docker compose -f infra/docker-compose.dev.yml up -d" >&2
    exit 1
  }
}

start_postgres() {
  need pg_isready
  if pg_isready -q 2>/dev/null; then
    log "postgres: already running"
  else
    log "postgres: starting"
    if command -v pg_ctlcluster >/dev/null 2>&1; then
      pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start 2>/dev/null || true
    elif command -v brew >/dev/null 2>&1; then
      brew services start postgresql@16 >/dev/null 2>&1 || true
    else
      service postgresql start >/dev/null 2>&1 || true
    fi
    for _ in $(seq 1 20); do pg_isready -q 2>/dev/null && break; sleep 0.5; done
    pg_isready -q || { echo "error: postgres failed to start" >&2; exit 1; }
  fi

  # Idempotent role/database provisioning.
  local psql_super=(psql -v ON_ERROR_STOP=1 -q)
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
    psql_super=(sudo -u postgres "${psql_super[@]}")
  elif [ "$(id -u)" -eq 0 ] && id postgres >/dev/null 2>&1; then
    psql_super=(su postgres -c)
  fi

  run_sql() {
    if [ "${psql_super[*]}" = "su postgres -c" ]; then
      su postgres -c "psql -v ON_ERROR_STOP=1 -q -tAc \"$1\""
    else
      "${psql_super[@]}" -tAc "$1"
    fi
  }

  if [ "$(run_sql "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" || true)" != "1" ]; then
    run_sql "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'" >/dev/null
    log "postgres: created role ${DB_USER}"
  fi
  if [ "$(run_sql "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" || true)" != "1" ]; then
    run_sql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}" >/dev/null
    log "postgres: created database ${DB_NAME}"
  fi
  log "postgres: ready on 127.0.0.1:5432 (db=${DB_NAME} user=${DB_USER})"
}

start_redis() {
  need redis-server
  if redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    log "redis: already running"
  else
    mkdir -p "$STATE_DIR"
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes \
      --save '' --appendonly no --pidfile "$PWD/$STATE_DIR/redis.pid" \
      --logfile "$PWD/$STATE_DIR/redis.log"
    for _ in $(seq 1 20); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.5; done
    redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 || { echo "error: redis failed to start" >&2; exit 1; }
  fi
  log "redis: ready on 127.0.0.1:${REDIS_PORT}"
}

case "${1:-start}" in
  start)
    echo "Starting local dev services (free, loopback only)"
    start_postgres
    start_redis
    echo "Done. Stop with: pnpm dev:services:stop"
    ;;
  stop)
    echo "Stopping local dev services"
    [ -f "$STATE_DIR/redis.pid" ] && kill "$(cat "$STATE_DIR/redis.pid")" 2>/dev/null && log "redis: stopped" || log "redis: not managed by this script"
    if command -v pg_ctlcluster >/dev/null 2>&1; then
      pg_ctlcluster "$(ls /etc/postgresql | head -1)" main stop 2>/dev/null && log "postgres: stopped" || log "postgres: not stopped (may be system-managed)"
    fi
    ;;
  status)
    pg_isready 2>/dev/null || true
    redis-cli -p "$REDIS_PORT" ping 2>/dev/null || echo "redis: down"
    ;;
  *)
    echo "usage: $0 {start|stop|status}" >&2; exit 2
    ;;
esac
