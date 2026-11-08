#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): 적용된 Prisma 마이그레이션은 고치지 않는다.
# 커밋된 마이그레이션은 프리뷰·운영 DB에 이미 적용됐거나 머지 후 migrate.yml이 적용하고, Prisma는
# 체크섬을 검사한다 — 하나라도 고치면 그 DB에서 `migrate deploy`가 멈춘다.
# 새 마이그레이션은 `npx prisma migrate dev --name <name>`으로 만든다(db-migration 스킬).
# 유일한 예외: 아직 git에 없는 마이그레이션 폴더(`migrate dev --create-only` 직후)에는
# 백필 SQL을 써 넣을 수 있다.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
  */workbridge-server/prisma/migrations/*|workbridge-server/prisma/migrations/*) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
rel="${file#"$root/"}"
dir="$(dirname "$rel")"

# 추적되지 않는 마이그레이션 폴더(안의 파일이 하나도 git에 없음) → 로컬 말고는 적용된 곳이 없다.
if [ -z "$(git -C "$root" ls-files -- "$dir")" ] && [ "$(basename "$(dirname "$dir")")" = "migrations" ]; then
  exit 0
fi

echo "차단: $rel 은 적용된(커밋된) 마이그레이션이라 고칠 수 없다 — 대신 prisma/schema.prisma를 고치고 \`npx prisma migrate dev --name <name>\`로 새 마이그레이션을 만든다 (.claude/rules/prisma.md)." >&2
exit 2
