---
name: run-workbridge
description: WorkBridge 앱을 로컬에서 빌드하고 띄워서 조작한다 — Express/Prisma 백엔드(:4000)와 Next.js 프론트엔드(:3000) 둘 다. WorkBridge(프리랜서 매칭 플랫폼, freelancer-matching platform)를 실행·시작·부팅·서빙(run, start, boot, serve)하거나, 스모크 테스트(smoke-test), E2E 테스트(E2E-test), 스크린샷(screenshot)을 요청받으면 쓴다.
---

# WorkBridge 실행

패키지 둘, 제품 하나: `workbridge-server`(Express + Prisma, **:4000**)와
`workbridge-client`(Next.js 14, **:3000**). 브라우저는 :3000하고만 통신한다 — 라우트 핸들러
`src/app/api/[...path]`와 `src/app/api/auth/*`가 `/api/*`를 :4000으로 전달한다.

확인하는 방법은 셋, 가벼운 것부터:
1. `bash .claude/skills/run-workbridge/drive.sh` — API 스모크(health, 목록, 시드 로그인, 프록시).
2. `node workbridge-client/scripts/screenshots.mjs` — 주요 페이지의 Playwright 스크린샷.
3. `bash scripts/e2e.sh`(리포지토리 루트) — `workbridge-client/e2e/`의 Playwright E2E 스펙.

화면 하나를 직접 조작해 볼 때는 `npx playwright cli`를 쓴다("조작" 절 끝).

경로는 모두 리포지토리 루트 기준이다.

## 준비물

- Node 22.x(`package.json`의 `engines`), npm. **localhost**의 PostgreSQL(`brew services start postgresql@14`, 슈퍼유저 =
  macOS 사용자, 비밀번호 없음).
- 2와 3에는 Playwright Chromium: `(cd workbridge-client && npx playwright install chromium)`.
- 외부 서비스(Google OAuth, OpenAI, 토스페이먼츠, Supabase Storage)는 더미 값을 쓴다:
  그 기능은 실패하지만, 핵심 흐름은 모두 로컬 DB로 동작한다.

## 설정 (한 번만)

`.env` 파일은 Claude의 파일 툴에 대해 거부 목록에 있다(`.claude/settings.json`). 쓰기가 거부되면
아래 블록을 사용자에게 보여 주고 직접 만들게 한다. URL은 모두 `localhost`를 쓴다.

```bash
createdb workbridge 2>/dev/null || echo "db exists (ok)"

cat > workbridge-server/.env <<EOF
PORT=4000
DATABASE_URL=postgresql://$(whoami)@localhost:5432/workbridge
DIRECT_URL=postgresql://$(whoami)@localhost:5432/workbridge
JWT_ACCESS_SECRET=local_dev_access_secret_change_me
JWT_REFRESH_SECRET=local_dev_refresh_secret_change_me
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
GOOGLE_CLIENT_ID=dummy
GOOGLE_CLIENT_SECRET=dummy
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
OPENAI_API_KEY=dummy
TOSS_SECRET_KEY=test_sk_dummy
ALLOW_PAYMENT_BYPASS=true
CLIENT_URL=http://localhost:3000
SUPABASE_URL=http://localhost:54321
SUPABASE_SECRET_KEY=sb_secret_dummy
PAYOUT_ACCOUNT_ENCRYPTION_KEY=$(openssl rand -base64 32)
TRUST_PROXY=loopback
RATE_LIMIT_ENABLED=false
MAIL_PROVIDER=log
JOB_PAYOUT_ENABLED=true
JOB_EMAIL_ENABLED=true
EOF

cat > workbridge-client/.env.local <<'EOF'
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_TOSS_CLIENT_KEY=test_ck_dummy
NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true
EOF

(cd workbridge-server && npm install)   # postinstall이 prisma generate를 돌린다
(cd workbridge-client && npm install)
(cd workbridge-server && npx prisma migrate deploy && npm run db:seed)
```

`RATE_LIMIT_ENABLED=false`로 두는 이유: 로컬 로그인은 모두 loopback에서 오므로 15분에 20회 한도 하나를
나눠 쓴다(`docs/domain/accounts.md` "로그인 요청 제한"). 시드는 마일스톤/정산/대화의 모든 상태를 덮고, 날짜는
지금 기준이다. **시드 계정 비밀번호는 모두 `password123`**
(`kim@example.com` CLIENT, `park@example.com` FREELANCER. 화면별로 어떤 계정을 쓸지는 `docs/SEED_DATA.md`).

## 실행

```bash
(cd workbridge-server && npm run dev > /tmp/wb-server.log 2>&1 &)
(cd workbridge-client && npm run dev > /tmp/wb-client.log 2>&1 &)
for i in $(seq 1 30); do
  grep -q "Server running on port" /tmp/wb-server.log 2>/dev/null \
    && grep -qE "Ready in|Local:" /tmp/wb-client.log 2>/dev/null && break
  sleep 1
done
tail -n2 /tmp/wb-server.log /tmp/wb-client.log
```

## 조작

1. **API 스모크** — `bash .claude/skills/run-workbridge/drive.sh` → `== 통과 4, 실패 0 ==`이 나와야 한다.
   다른 포트: `API_PORT=4001 CLIENT_PORT=3001 bash .claude/skills/run-workbridge/drive.sh`.
2. **스크린샷** — `node workbridge-client/scripts/screenshots.mjs`(페이지 목록, 출력 폴더, 옵션은 파일
   머리 주석에 있다). 경로마다 먼저 한 번 불러 두고(새로 띄운 `next dev`는 처음 요청 때 컴파일한다)
   클라이언트 쪽 fetch를 기다린다. PNG가 비어 있지 않다고 해서 증명되는 것은 없다: **이미지를 열어서
   본다** — 빈 화면이나 에러 오버레이면 페이지가 hydrate되지 않은 것이다.
3. **E2E** — 리포지토리 루트에서 `bash scripts/e2e.sh`가 `workbridge-client/e2e/`의 Playwright 스펙을
   돌린다. 스펙은 화면의 한국어 텍스트로 요소를 찾으므로, 클라이언트 문구를 바꾸면 같은 변경에서
   스펙도 고친다.

화면 하나를 그때그때 볼 때는 리포지토리의 Playwright에 들어 있는 CLI로 실제 브라우저를 조작한다.
루트에는 `package.json`이 없으므로 `workbridge-client/` 안에서 돌린다:

```bash
cd workbridge-client
npx playwright cli -s=wb open http://localhost:3000/login   # -s=<세션>: 작업마다 다른 이름
npx playwright cli -s=wb snapshot                           # 요소마다 ref(e1, e2 …)가 붙은 접근성 트리
npx playwright cli -s=wb fill <ref> "kim@example.com"       # ref는 방금 찍은 snapshot에서
npx playwright cli -s=wb click <ref>
npx playwright cli -s=wb screenshot                         # 산출물은 .playwright-cli/ (git 무시)
npx playwright cli -s=wb close
```

명령 목록은 `npx playwright cli --help`, 에이전트용 사용법은 그 첫 줄이 가리키는 SKILL.md에 있다.

간단한 수동 확인: `curl -s http://localhost:4000/health` → `{"status":"ok"}`,
`curl -s http://localhost:3000/api/projects | head -c 200` → 프록시를 거친 JSON.
API 문서 화면은 `http://localhost:4000/api/docs`, 원본은 `http://localhost:4000/api/openapi.json`이다.

기본이 아닌 포트: 서버 `.env`에 `PORT=4001`, `CLIENT_URL=http://localhost:3001`, 클라이언트
`.env.local`에 `API_URL`/`NEXT_PUBLIC_API_URL=http://localhost:4001`, 시작은 `npx next dev -p 3001`.

## 주의할 점

- **시드 날짜는 밀린다.** 마감이 지나면 목록을 읽을 때 프로젝트가 닫힌다
  (`lib/projectLifecycle.ts`). 다시 시드: `(cd workbridge-server && npm run db:seed)`. 시드는
  `workbridge-server/.env`를 읽고(이미 셸에 있는 값이 우선), 지급 계좌번호를 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`로 암호화한다 —
  `.env`의 키를 바꿨다면 다시 시드한다.
- **결제 우회가 켜져 있다**(로컬, 플래그 둘 다). 결제는 마일스톤 단위다:
  `POST /api/payments/dev-complete`가 `{ milestoneId }`를 받고, 순서대로 결제된다.
- **업로드에는 저장소 스텁이 필요하다.** `SUPABASE_URL=http://localhost:54321`은 아래를 띄우기 전까지 아무것도 가리키지 않는다:
  `(cd workbridge-server && node scripts/storage-stub.mjs > /tmp/wb-storage.log 2>&1 &)`.
  메모리 저장소라 다시 띄우면 파일이 사라진다. 서명 업로드·브라우저의 PUT·서명 다운로드·공개 URL까지 흉내 내므로
  첨부와 이미지가 화면에서 열린다. 없으면 첨부 업로드 URL 발급이 502로 답한다.
- **이메일은 로그로만 남는다**: `grep mail.sent /tmp/wb-server.log`(개발 워커가 ~5초 안에 보낸다).
- **미래 시각의 작업.** 주간 정산, 지급, 읽지 않은 메시지 다이제스트는 미래 시각에 잡힌다. 지금 보려면 `workbridge-server/` 안에서 `tsx` 일회성 스크립트로
  `runDueJobs({ now: <future>, types: ['settlement.weeklyBatch', 'settlement.payout'] })`를 두 번
  부른다(첫 번째가 다음 작업을 넣는다). `types`는 항상 제한한다. 그러지 않으면 수명주기 스윕이 마감이
  그 날짜 전인 프로젝트를 모두 닫는다.

## 문제 해결

- `P1001` can't reach database → Postgres가 꺼져 있거나 `DATABASE_URL`의 DB가 틀렸다.
- `@prisma/client did not initialize yet` → `(cd workbridge-server && npm run db:generate)`.
- `relation "Project" does not exist` → `(cd workbridge-server && npx prisma migrate deploy)`.
- `EADDRINUSE` → `lsof -ti:4000 -ti:3000 | xargs kill`.
- 로그인 429 → `RATE_LIMIT_ENABLED=false`로 두고 재시작하거나,
  `psql -d workbridge -c 'DELETE FROM "RateLimitCounter"'`.
- CORS 오류 → `CLIENT_URL`이 `http://localhost:3000`이어야 한다.
