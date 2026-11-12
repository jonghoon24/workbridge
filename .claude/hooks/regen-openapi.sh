#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): workbridge-server/src/**/*.ts 대상.
# 서버 코드를 고칠 때마다 openapi.json을 다시 만든다. 문서는 zod 스키마(src/schemas), 등록(src/openapi),
# 라우트, Prisma enum에서 나오므로 어느 파일이 바뀌어도 결과가 달라질 수 있다. 생성은 DB·환경변수·네트워크
# 없이 1초 안에 끝난다. 바뀐 openapi.json은 작업 트리에 남아 다음 커밋에 함께 들어간다(ci.yml이 최신인지 검사한다).
# 편집 도중이라 코드가 아직 컴파일되지 않으면 생성이 실패한다. 그때는 조용히 넘어간다 — 다음 편집이나
# typecheck(Stop 훅), CI가 잡는다.
# Stop 훅으로 미루지 않는 이유: Claude는 턴 도중에 커밋한다(pre-pr-review 스킬). 미루면 낡은
# openapi.json이 그 커밋에 들어간다.
set -uo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")

case "$file" in
  */workbridge-server/src/*.ts) ;;
  *) exit 0 ;;
esac

server_dir="${file%%/src/*}"
(cd "$server_dir" && npm run -s openapi >/dev/null 2>&1) || true
exit 0
