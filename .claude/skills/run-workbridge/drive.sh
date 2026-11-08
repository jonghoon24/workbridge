#!/usr/bin/env bash
# API smoke test of the running WorkBridge app:
#   - backend health and project list (:$API_PORT, default 4000)
#   - a real seed-account login
#   - the frontend's same-origin /api proxy (:$CLIENT_PORT, default 3000)
# Browser checks live elsewhere: E2E `bash scripts/e2e.sh`, screenshots
# `workbridge-client/scripts/screenshots.mjs` (see SKILL.md).
#
# Assumes both dev servers are ALREADY running (see SKILL.md "Run").
# Usage:  [API_PORT=4001 CLIENT_PORT=3001] bash drive.sh
set -uo pipefail

API="http://localhost:${API_PORT:-4000}"
WEB="http://localhost:${CLIENT_PORT:-3000}"

pass=0; fail=0
ok(){   echo "  ✓ $1"; pass=$((pass+1)); }
bad(){  echo "  ✗ $1"; fail=$((fail+1)); }

echo "== Backend API ($API) =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$code" = "200" ] && ok "/health -> 200" || bad "/health -> $code"

curl -s "$API/api/projects" | grep -q '"projects"' \
  && ok "/api/projects returns a list" || bad "/api/projects"

token=$(curl -s -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"kim@example.com","password":"password123"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write((JSON.parse(d).accessToken||"").slice(0,10)))')
[ -n "$token" ] && ok "seed login returns access token" || bad "seed login"

echo "== Frontend proxy ($WEB) =="
curl -s "$WEB/api/projects" | grep -q '"projects"' \
  && ok "same-origin /api proxy reaches backend" || bad "/api proxy"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
