#!/usr/bin/env bash
# Drives the running WorkBridge app end-to-end:
#   - API smoke tests against the backend (:4000)
#   - a real seed-account login
#   - browser screenshots of the frontend (:3000) via headless Chrome
#
# Assumes both dev servers are ALREADY running (see SKILL.md "Run").
# Usage:  bash drive.sh [screenshot-out-dir]
set -uo pipefail

OUT="${1:-${TMPDIR:-/tmp}/workbridge-shots}"
mkdir -p "$OUT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
API="http://localhost:4000"
WEB="http://localhost:3000"

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

echo "== Browser screenshots -> $OUT =="
if [ -x "$CHROME" ]; then
  for path in "" projects; do
    name="${path:-home}"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --virtual-time-budget=8000 --window-size=1280,1400 \
      --screenshot="$OUT/$name.png" "$WEB/$path" 2>/dev/null
    [ -s "$OUT/$name.png" ] && ok "$name.png" || bad "$name.png"
  done
else
  echo "  (skip) Chrome not found at: $CHROME"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
