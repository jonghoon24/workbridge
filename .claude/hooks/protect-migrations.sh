#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): applied Prisma migrations are immutable.
# A committed migration has run (or will run on merge, via CI) on the preview and production
# databases, and Prisma verifies its checksum — editing one breaks `migrate deploy` there.
# New migrations come from `npx prisma migrate dev --name <name>` (db-migration skill).
# The one exception: a migration folder that is not in git yet (fresh from
# `migrate dev --create-only`) may still get its backfill SQL.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
  */workbridge-server/prisma/migrations/*|workbridge-server/prisma/migrations/*) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
rel="${file#"$root/"}"
dir="$(dirname "$rel")"

# Untracked migration folder (nothing in it is in git yet) → not applied anywhere but locally.
if [ -z "$(git -C "$root" ls-files -- "$dir")" ] && [ "$(basename "$(dirname "$dir")")" = "migrations" ]; then
  exit 0
fi

echo "차단: $rel 은 적용된(커밋된) 마이그레이션이라 고칠 수 없다 — 대신 prisma/schema.prisma를 고치고 \`npx prisma migrate dev --name <name>\`로 새 마이그레이션을 만든다 (.claude/rules/prisma.md)." >&2
exit 2
