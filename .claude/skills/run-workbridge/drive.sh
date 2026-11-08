#!/usr/bin/env bash
# 떠 있는 WorkBridge 앱의 API 스모크 테스트:
#   - 백엔드 health와 프로젝트 목록 (:$API_PORT, 기본 4000)
#   - 실제 시드 계정 로그인
#   - 프론트엔드의 같은 출처 /api 프록시 (:$CLIENT_PORT, 기본 3000)
# 브라우저 확인은 따로 한다: E2E `bash scripts/e2e.sh`, 스크린샷
# `workbridge-client/scripts/screenshots.mjs`, `npx playwright cli`(SKILL.md 참고).
#
# dev 서버 두 개가 이미 떠 있어야 한다(SKILL.md "실행").
# 사용법:  [API_PORT=4001 CLIENT_PORT=3001] bash drive.sh
set -uo pipefail

API="http://localhost:${API_PORT:-4000}"
WEB="http://localhost:${CLIENT_PORT:-3000}"

pass=0; fail=0
ok(){   echo "  ✓ $1"; pass=$((pass+1)); }
bad(){  echo "  ✗ $1"; fail=$((fail+1)); }

echo "== 백엔드 API ($API) =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$code" = "200" ] && ok "/health -> 200" || bad "/health -> $code"

curl -s "$API/api/projects" | grep -q '"projects"' \
  && ok "/api/projects 목록 응답" || bad "/api/projects"

token=$(curl -s -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"kim@example.com","password":"password123"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let t="";try{t=JSON.parse(d).accessToken||""}catch{}process.stdout.write(t.slice(0,10))})')
[ -n "$token" ] && ok "시드 계정 로그인 → 액세스 토큰" || bad "시드 계정 로그인"

echo "== 프론트엔드 프록시 ($WEB) =="
curl -s "$WEB/api/projects" | grep -q '"projects"' \
  && ok "같은 출처 /api 프록시 → 백엔드" || bad "/api 프록시"

echo "== 통과 $pass, 실패 $fail =="
[ "$fail" -eq 0 ]
