#!/usr/bin/env bash
# Stop: Claude가 끝내기 전에 HEAD 이후 바뀐 곳의 가벼운 정적 검사를 돌린다.
#   workbridge-server/**/*.ts 변경 → npm run typecheck (src/와 test/ 모두)
#   workbridge-server/**/*.{ts,js,mjs} 변경 → npm run lint (CI와 같은 기준)
#   workbridge-client/src/** 변경   → npm run lint (경고도 실패. 기준은 package.json)
# exit 2면 실패한 마지막 줄이 Claude에게 돌아가 작업을 이어 간다.
# 서버 테스트 스위트는 일부러 돌리지 않는다. 실제 Postgres가 필요하고 오래 걸려서, DB가 없는 환경에서는
# 매번 실패해 Claude를 붙잡는다. 파일 단위 테스트는 Claude가 `npx vitest run`으로 돌리고, 전체는 ci.yml이 돌린다.
# 통과한 작업 트리 상태(추적 안 된 파일 포함 해시)를 .git에 기록해 두고, 그 뒤로 아무것도 바뀌지 않았으면
# 다시 돌리지 않는다 — 커밋하지 않은 변경을 둔 채 질문만 주고받는 턴마다 검사가 다시 도는 것을 막는다.
set -uo pipefail

input=$(cat)
# 무한 루프 방지: 이미 이 훅 때문에 이어서 작업하는 중이면 그대로 끝내게 둔다.
if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" || exit 0

changed=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
[ -z "$changed" ] && exit 0

# 작업 트리 상태의 해시: HEAD, HEAD 대비 diff, 추적 안 된 파일의 이름과 내용 해시. 객체를 .git에 쓰지 않는다.
stamp_file=$(git rev-parse --git-path claude-stop-check.ok 2>/dev/null)
tree=$( { git rev-parse HEAD && git diff --binary HEAD \
          && git ls-files --others --exclude-standard \
          && git ls-files -z --others --exclude-standard | xargs -0 git hash-object --; } 2>/dev/null \
        | git hash-object --stdin 2>/dev/null) || tree=""
if [ -n "$tree" ] && [ -n "$stamp_file" ] && [ "$(cat "$stamp_file" 2>/dev/null)" = "$tree" ]; then
  exit 0
fi
skipped=false

fail() { # $1 = label, $2 = output
  {
    echo "종료 전 검사 실패: $1. 끝내기 전에 고친다 (마지막 줄):"
    tail -n 30 <<<"$2"
  } >&2
  exit 2
}

if grep -qE '^workbridge-server/.*\.ts$' <<<"$changed"; then
  if [ -d workbridge-server/node_modules ]; then
    out=$(cd workbridge-server && npm run --silent typecheck 2>&1) || fail "workbridge-server npm run typecheck" "$out"
  else
    echo "stop-check: workbridge-server/node_modules가 없어 typecheck를 건너뛰었다 (npm install 필요)" >&2
    skipped=true
  fi
fi

if grep -qE '^workbridge-server/.*\.(ts|js|mjs)$' <<<"$changed"; then
  if [ -d workbridge-server/node_modules ]; then
    out=$(cd workbridge-server && npm run --silent lint 2>&1) || fail "workbridge-server npm run lint" "$out"
  else
    echo "stop-check: workbridge-server/node_modules가 없어 lint를 건너뛰었다 (npm install 필요)" >&2
    skipped=true
  fi
fi

if grep -qE '^workbridge-client/src/' <<<"$changed"; then
  if [ -d workbridge-client/node_modules ]; then
    out=$(cd workbridge-client && npm run --silent lint 2>&1) || fail "workbridge-client npm run lint" "$out"
  else
    echo "stop-check: workbridge-client/node_modules가 없어 lint를 건너뛰었다 (npm install 필요)" >&2
    skipped=true
  fi
fi

# 모든 검사를 실제로 돌려 통과했을 때만 기록한다.
if [ "$skipped" = false ] && [ -n "$tree" ] && [ -n "$stamp_file" ]; then
  echo "$tree" > "$stamp_file"
fi
exit 0
