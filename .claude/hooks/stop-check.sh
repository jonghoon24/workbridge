#!/usr/bin/env bash
# Stop: before Claude finishes, run the cheap static checks for whatever changed since HEAD.
#   workbridge-server/**/*.ts changed → npm run typecheck (covers src/ and test/)
#   workbridge-client/src/** changed   → npm run lint
# Exit 2 sends the failing tail back to Claude so it keeps working. The server test suite is
# deliberately NOT run here (real Postgres, ~90 s) — see docs/HARNESS.md.
set -uo pipefail

input=$(cat)
# Loop guard: if Claude is already continuing because of this hook, let it stop.
if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" || exit 0

changed=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
[ -z "$changed" ] && exit 0

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
  fi
fi

if grep -qE '^workbridge-client/src/' <<<"$changed"; then
  if [ -d workbridge-client/node_modules ]; then
    out=$(cd workbridge-client && npm run --silent lint 2>&1) || fail "workbridge-client npm run lint" "$out"
  else
    echo "stop-check: workbridge-client/node_modules가 없어 lint를 건너뛰었다 (npm install 필요)" >&2
  fi
fi
exit 0
