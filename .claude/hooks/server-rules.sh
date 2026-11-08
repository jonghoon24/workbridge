#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit) on workbridge-server/src/**/*.ts.
# Advice, not a block: the edit has already happened. Exit 2 sends stderr back to Claude.
# It inspects only the text that was just written (Write: content, Edit: new_string,
# MultiEdit: every new_string), so pre-existing, documented exceptions in a file
# (googleCallback's console.error, the AI prompt's toLocaleDateString) don't re-fire on
# every unrelated edit. Comment lines are ignored.
set -euo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")

case "$file" in
  */workbridge-server/src/*.ts) ;;
  *) exit 0 ;;
esac
case "$file" in
  # The two libs that implement the rules, and the jobs CLI whose job is printing to stdout.
  */src/lib/time.ts|*/src/lib/logger.ts|*/src/jobs/cli.ts) exit 0 ;;
esac

written=$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)]
                 | map(select(. != null)) | join("\n")' <<<"$input" \
          | grep -vE '^[[:space:]]*(//|\*|/\*)' || true)

problems=()

if grep -qE '\bconsole\.' <<<"$written"; then
  problems+=("서버 코드에서는 임시 디버그 줄을 포함해 console.*를 쓰지 않는다 → src/lib/logger.ts의 \`logger.debug|info|warn(msg, fields)\`로 바꾼다. logger.error는 errorHandler의 500과 작업 실패 전용이다. 지침: .claude/rules/notifications-logging.md")
fi

case "$file" in
  */src/services/*|*/src/jobs/handlers/*)
    if grep -qE 'new Date\(\)' <<<"$written"; then
      problems+=("서비스/작업 핸들러에서 new Date() 사용 → \`now\`를 인자로 받는다(핸들러는 ctx.now). 그래야 테스트가 runJobs(now)로 시간을 제어한다. 지침: .claude/rules/money-time.md")
    fi
    ;;
esac

if grep -qE '\.(getDate|getHours|getDay|setHours|setDate)\(|toLocaleDateString\(' <<<"$written"; then
  problems+=("호스트 시간대 날짜 getter/setter 사용 → src/lib/time.ts의 고정 UTC+9 헬퍼(startOfKstDay, kstDateString, nextKstWeekday…)를 쓴다. CI와 Vercel은 UTC로 돈다. 지침: .claude/rules/money-time.md")
fi

if [ ${#problems[@]} -gt 0 ]; then
  {
    echo "WorkBridge 지침 검사 (${file#"${CLAUDE_PROJECT_DIR:-}/"}):"
    for p in "${problems[@]}"; do echo "- $p"; done
    echo "위 줄을 지금 고쳐 쓴다. 허용되는 예외는 지침 파일에 적힌 것뿐이다."
  } >&2
  exit 2
fi
exit 0
