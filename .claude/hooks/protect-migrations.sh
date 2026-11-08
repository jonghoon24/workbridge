#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): applied Prisma migrations are immutable.
# They have already run on the preview and production databases, and Prisma verifies their
# checksums — editing one breaks `migrate deploy` there. New migrations come from
# `npx prisma migrate dev --name <name>` (see the db-migration skill), not from file edits.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
  */workbridge-server/prisma/migrations/*|workbridge-server/prisma/migrations/*)
    echo "Blocked: ${file#"${CLAUDE_PROJECT_DIR:-}/"} is an applied migration and must not be edited — change prisma/schema.prisma and run \`npx prisma migrate dev --name <name>\` instead (.claude/rules/prisma.md)." >&2
    exit 2
    ;;
esac
exit 0
