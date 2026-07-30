#!/usr/bin/env bash
# Creates (if needed) and migrates a test database, then prints its URL.
#
#   bash scripts/test-db.sh                  # -> workbridge_test
#   bash scripts/test-db.sh workbridge_test_3
#
# Each parallel agent or CI job should use its own database name: the suite truncates every
# table between tests, so two runs sharing one database will destroy each other's fixtures.
set -euo pipefail

DB_NAME="${1:-workbridge_test}"
DB_USER="${PGUSER:-$(whoami)}"
DB_URL="postgresql://${DB_USER}@localhost:5432/${DB_NAME}"

createdb "$DB_NAME" 2>/dev/null || true   # already exists is fine

DATABASE_URL="$DB_URL" DIRECT_URL="$DB_URL" npx prisma migrate deploy >/dev/null

echo "$DB_URL"
