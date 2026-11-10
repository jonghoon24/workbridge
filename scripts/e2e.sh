#!/usr/bin/env bash
# WorkBridge E2E runner: fresh seeded DB -> API (tsx) + client (Next) -> Playwright.
#
# Usage: bash scripts/e2e.sh [playwright args...]
#
# Env (all optional):
#   E2E_DB              database name (default workbridge_e2e)
#   E2E_DATABASE_URL    full Postgres URL (default postgresql://$USER@localhost:5432/$E2E_DB)
#   E2E_SERVER_PORT     API port   (default 4002)
#   E2E_CLIENT_PORT     client port (default 3002)
#   E2E_CLIENT_MODE     dev | prod  (default prod when CI=true, otherwise dev)
#   E2E_SKIP_SEED=1     reuse the current DB contents (skip migrate + seed)
#
# Shell variables like DATABASE_URL are set explicitly below, never read from the caller's shell,
# so this cannot accidentally migrate/seed (= wipe) some other database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/workbridge-server"
CLIENT_DIR="$ROOT/workbridge-client"

E2E_DB="${E2E_DB:-workbridge_e2e}"
DB_URL="${E2E_DATABASE_URL:-postgresql://$(whoami)@localhost:5432/$E2E_DB}"
DB_NAME="$(basename "${DB_URL%%\?*}")"
SERVER_PORT="${E2E_SERVER_PORT:-4002}"
CLIENT_PORT="${E2E_CLIENT_PORT:-3002}"
if [[ "${CI:-}" == "true" ]]; then DEFAULT_MODE=prod; else DEFAULT_MODE=dev; fi
CLIENT_MODE="${E2E_CLIENT_MODE:-$DEFAULT_MODE}"
LOG_DIR="${E2E_LOG_DIR:-$CLIENT_DIR/test-results/e2e-logs}"

API_URL_LOCAL="http://localhost:$SERVER_PORT"
CLIENT_URL_LOCAL="http://localhost:$CLIENT_PORT"

log() { printf '\n== %s\n' "$*"; }

for port in "$SERVER_PORT" "$CLIENT_PORT"; do
  if curl -s -o /dev/null --max-time 2 "http://localhost:$port"; then
    echo "port $port is already in use — stop whatever is listening there first" >&2
    exit 1
  fi
done

PIDS=()
cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    # Kill the whole process group (npx -> node -> next/tsx children).
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  exit "$code"
}
trap cleanup EXIT INT TERM

# Start a command in its own process group so cleanup can take down every child.
start_bg() {
  local logfile="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$logfile" 2>&1 &
  else
    set -m
    "$@" >"$logfile" 2>&1 &
    set +m
  fi
  PIDS+=("$!")
}

wait_for() {
  local name="$1" url="$2" logfile="$3" timeout="${4:-180}"
  for ((i = 0; i < timeout; i++)); do
    if curl -sf -o /dev/null "$url"; then
      echo "$name ready ($url)"
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready at $url within ${timeout}s — last log lines:" >&2
  tail -n 40 "$logfile" >&2 || true
  return 1
}

mkdir -p "$LOG_DIR"

# --- Database ---------------------------------------------------------------
export DATABASE_URL="$DB_URL"
export DIRECT_URL="$DB_URL"
# The seed and the server must share it: the seed stores payout account numbers encrypted with it.
# A fixed E2E-only key (base64 of the 32 ASCII bytes `e2e-payout-account-key-32-bytes!`).
export PAYOUT_ACCOUNT_ENCRYPTION_KEY=ZTJlLXBheW91dC1hY2NvdW50LWtleS0zMi1ieXRlcyE=

if [[ "${E2E_SKIP_SEED:-}" != "1" ]]; then
  log "database $DB_NAME"
  ADMIN_URL="${DB_URL%/*}/postgres"
  if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
    psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
    echo "created $DB_NAME"
  fi
  (cd "$SERVER_DIR" && npx prisma migrate deploy && npm run db:seed)
fi

# --- API server -------------------------------------------------------------
log "server on :$SERVER_PORT"
SERVER_ENV=(
  PORT="$SERVER_PORT"
  CLIENT_URL="$CLIENT_URL_LOCAL"
  JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-e2e_access_secret}"
  JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-e2e_refresh_secret}"
  JWT_ACCESS_EXPIRES_IN=15m
  JWT_REFRESH_EXPIRES_IN=7d
  GOOGLE_CLIENT_ID=dummy
  GOOGLE_CLIENT_SECRET=dummy
  GOOGLE_CALLBACK_URL="$CLIENT_URL_LOCAL/api/auth/google/callback"
  OPENAI_API_KEY=dummy
  TOSS_SECRET_KEY=test_sk_dummy
  SUPABASE_URL=https://dummy.supabase.co
  SUPABASE_SECRET_KEY=sb_secret_dummy
  PAYOUT_ACCOUNT_ENCRYPTION_KEY="$PAYOUT_ACCOUNT_ENCRYPTION_KEY"
  ALLOW_PAYMENT_BYPASS=true
  TRUST_PROXY=loopback
  RATE_LIMIT_ENABLED=false
  JOB_WORKER_ENABLED=false
  MAIL_PROVIDER=log
  LOG_LEVEL="${LOG_LEVEL:-warn}"
)
# NODE_ENV=production|test would skip app.listen(), so it is removed for the server.
start_bg "$LOG_DIR/server.log" \
  env -u NODE_ENV "${SERVER_ENV[@]}" bash -c "cd '$SERVER_DIR' && exec npx tsx src/index.ts"

# --- Client -----------------------------------------------------------------
export API_URL="$API_URL_LOCAL"
export NEXT_PUBLIC_API_URL="$API_URL_LOCAL"
export NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true
export NEXT_PUBLIC_TOSS_CLIENT_KEY=test_ck_dummy

cd "$CLIENT_DIR"
if [[ "$CLIENT_MODE" == "prod" ]]; then
  log "client build"
  npx next build >"$LOG_DIR/client-build.log" 2>&1 || { tail -n 60 "$LOG_DIR/client-build.log"; exit 1; }
  log "client (next start) on :$CLIENT_PORT"
  start_bg "$LOG_DIR/client.log" npx next start -p "$CLIENT_PORT"
else
  log "client (next dev) on :$CLIENT_PORT"
  start_bg "$LOG_DIR/client.log" npx next dev -p "$CLIENT_PORT"
fi

wait_for server "$API_URL_LOCAL/health" "$LOG_DIR/server.log"
wait_for client "$CLIENT_URL_LOCAL/login" "$LOG_DIR/client.log"

if [[ "$CLIENT_MODE" == "dev" ]]; then
  # next dev compiles each route on first hit; warm them so specs do not time out on compilation.
  log "warming routes"
  for path in / /login /projects /projects/new /projects/x /projects/x/applications \
    /my/applications /my/contracts /contracts/x /contracts/x/milestones/y /payments/x \
    /payments/result /api/projects; do
    curl -s -o /dev/null --max-time 120 "$CLIENT_URL_LOCAL$path" || true
  done
fi

# --- Tests ------------------------------------------------------------------
log "playwright"
export E2E_BASE_URL="$CLIENT_URL_LOCAL"
npx playwright test -c e2e/playwright.config.js "$@"
