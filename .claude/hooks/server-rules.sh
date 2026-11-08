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
  problems+=("console.* is not used in server code, temporary debug lines included → replace it with \`logger.debug|info|warn(msg, fields)\` from src/lib/logger.ts. logger.error is reserved for errorHandler's 500s and job failures. Rule: .claude/rules/notifications-logging.md")
fi

case "$file" in
  */src/services/*|*/src/jobs/handlers/*)
    if grep -qE 'new Date\(\)' <<<"$written"; then
      problems+=("new Date() in a service/job handler → take \`now\` as an argument (handlers use ctx.now) so tests control time with runJobs(now). Rule: .claude/rules/money-time.md")
    fi
    ;;
esac

if grep -qE '\.(getDate|getHours|getDay|setHours|setDate)\(|toLocaleDateString\(' <<<"$written"; then
  problems+=("host-timezone date getter/setter → use the fixed UTC+9 helpers in src/lib/time.ts (startOfKstDay, kstDateString, nextKstWeekday…); CI and Vercel run in UTC. Rule: .claude/rules/money-time.md")
fi

if [ ${#problems[@]} -gt 0 ]; then
  {
    echo "WorkBridge rule check on ${file#"${CLAUDE_PROJECT_DIR:-}/"}:"
    for p in "${problems[@]}"; do echo "- $p"; done
    echo "Rewrite the lines above now; the only accepted exceptions are the ones listed in the rule file."
  } >&2
  exit 2
fi
exit 0
