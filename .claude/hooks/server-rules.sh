#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): workbridge-server/src/**/*.ts 대상.
# 막는 것이 아니라 알리는 것이다 — 편집은 이미 일어났다. exit 2면 stderr가 Claude에게 돌아간다.
# 방금 쓴 텍스트만 본다(Write: content, Edit: new_string, MultiEdit: 모든 new_string). 그래서 파일에
# 이미 있는 문서화된 예외(AI 프롬프트의 toLocaleDateString)가
# 상관없는 편집 때마다 다시 걸리지 않는다. 주석 줄은 무시한다.
set -euo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")

case "$file" in
  */workbridge-server/src/*.ts) ;;
  *) exit 0 ;;
esac
case "$file" in
  # 규칙을 구현하는 lib 두 개, 그리고 stdout 출력이 본업인 작업 CLI.
  */src/lib/time.ts|*/src/lib/logger.ts|*/src/jobs/cli.ts) exit 0 ;;
esac

written=$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)]
                 | map(select(. != null)) | join("\n")' <<<"$input" \
          | grep -vE '^[[:space:]]*(//|\*|/\*)' || true)

problems=()

if grep -qE '\bconsole\.' <<<"$written"; then
  problems+=("서버 코드에서는 임시 디버그 줄을 포함해 console.*를 쓰지 않는다 → src/lib/logger.ts의 \`logger.debug|info|warn(msg, fields)\`로 바꾼다. 필드에는 필요한 값만 넣고 req.body·req.query·헤더를 통째로 넣지 않는다(개인정보·토큰). logger.error는 errorHandler의 500, 응답을 보낸 뒤에 난 예외, 작업 실패 전용이다. 지침: .claude/rules/notifications-logging.md")
fi

case "$file" in
  */src/services/*|*/src/jobs/handlers/*)
    if grep -qE 'new Date\(\)' <<<"$written"; then
      problems+=("서비스/작업 핸들러에서 new Date() 사용 → \`now\`를 인자로 받는다(핸들러는 ctx.now). 그래야 테스트가 runJobs(now)로 시간을 제어한다. 지침: .claude/rules/money-time.md")
    fi
    ;;
esac

# 호스트 시간대를 따르는 Date getter/setter. toLocaleString은 금액 포맷(templates.ts)과 겹쳐서 넣지 않는다.
if grep -qE '\.(get|set)(Date|Day|Hours|Month|FullYear)\(|toLocaleDateString\(' <<<"$written"; then
  problems+=("호스트 시간대 날짜 getter/setter 사용 → src/lib/time.ts의 고정 UTC+9 헬퍼(startOfKstDay, kstDateString, kstMonthString, nextKstWeekday…)를 쓴다. CI와 Vercel은 UTC로 돈다. 지침: .claude/rules/money-time.md")
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
