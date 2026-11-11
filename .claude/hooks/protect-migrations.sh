#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): 적용된 Prisma 마이그레이션은 고치지 않는다.
# 커밋된 마이그레이션은 프리뷰·운영 DB에 이미 적용됐거나 머지 후 migrate.yml이 적용한다. 고쳐도
# `migrate deploy`는 이미 적용한 것으로 보고 다시 돌리지 않는다(오류 없이 넘어간다). 그래서 고친 내용은
# 프리뷰·운영에 들어가지 않고, 새로 만드는 DB(CI·로컬)에만 들어가 환경마다 스키마가 갈라진다.
# 이 훅은 jq가 필요하다. jq가 없으면 오류(127)로 끝나 막지 못한다.
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
