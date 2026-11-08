# 하네스 구성

이 리포지토리에서 Claude Code가 일할 때 쓰는 하네스를 정리한다. 요소마다 파일, **이 코드베이스의 어떤 규칙이나
사고 때문에 있는지**, 한계를 적는다. 규칙의 근거는 `docs/BEHAVIOR.md`(명세, D번호는 "Known divergences" 표)와 코드다.

## 1. 지침 파일 — `CLAUDE.md`

모든 세션과 CI 리뷰어가 매번 읽는다. 그래서 안내판 역할만 한다: 제품 한 문단, 패키지 두 개, 커맨드, 어떤 문서를
언제 읽을지, 그리고 바로 사고가 나는 "함정" 10개(`import 'dotenv/config'`가 첫 import, 라우터 마운트 순서,
`GET /api/projects`가 행을 씀, 공개 핸들러의 `req.user`, `Promise<void>` 금지 등). 상세 구조는
`docs/ARCHITECTURE.md`로, 경로별 지시는 rules로 보냈다. 80줄 이하로 유지한다.

## 2. 경로별 rules — `.claude/rules/*.md`

`paths:` 프론트매터에 맞는 파일을 읽거나 고칠 때만 컨텍스트에 들어온다.

| 파일 | 불러오는 경로 | 왜 있는가 |
|---|---|---|
| `server-layers.md` | `workbridge-server/src/**/*.ts` | 기존/확장 레이어 혼재는 의도된 것(규칙 12). 기존 컨트롤러에 zod·서비스·`requireActiveUser`를 붙이면 D12 핀(`soft-delete.test.ts` `mutations`)이 예기치 않게 통과해 스위트가 깨진다. 트랜잭션 안 P2002 금지(D4 수정 방식), `lockUserRow` 첫 문장 |
| `money-time.md` | 서비스, 작업, 스키마, `lib/money.ts`·`time.ts`, 결제·마일스톤·정산 컨트롤러 | M3/M5/M7 금액 규칙은 `lib/money.ts`에만. CI·Vercel은 UTC라 호스트 시간대 함수는 기기마다 답이 다르다 |
| `jobs.md` | `src/jobs/**`, 서비스, `internal.controller.ts` | 트랜잭션 아웃박스, `create`+P2002 catch가 트랜잭션 전체를 중단시키는 문제, 운영에 워커가 없음 |
| `notifications-logging.md` | `workbridge-server/src/**/*.ts` | 알림은 `notify()`만(NC9). 스위트가 "500은 한 번만 error 로그"를 단언한다(규칙 1, 9) |
| `tests.md` | `workbridge-server/test/**`, `vitest.config.ts`, `docs/BEHAVIOR.md` | 실제 Postgres, 팩토리, 가짜 타이머 금지, `it.fails` 핀은 수정과 함께만 뒤집기, 공통 관심사는 중앙 매트릭스에서 한 번 |
| `prisma.md` | `workbridge-server/prisma/**`, `docs/DATABASE.md` | 적용된 마이그레이션 불변, `seed.js`는 CommonJS, `deletedAt: null`(D1, D19, D21) |
| `client.md` | `workbridge-client/**` | JSX 유지, `lib/api.js`만, `middleware.js`는 쿠키 존재만 봄, 문구를 바꾸면 E2E도 함께 |
| `deploy.md` | `vercel.json`, `index.ts`, `env.ts`, `package.json`, 워크플로, `DEPLOYMENT.md`, `ENV.md` | `vercel.json`의 진입점 두 곳, `dist/` 없음, Preview/Production이 서로 다른 Supabase 프로젝트 |

**한계.** 경로가 맞는 파일을 읽어야 들어온다. 파일을 읽지 않고 답하는 질문에는 rules가 없다.

## 3. 권한 규칙 — `.claude/settings.json` `permissions`

| 규칙 | 왜 있는가 |
|---|---|
| `Read(**/.env)` 등 `.env` 계열 deny | 서버 `.env`에 JWT 비밀키, OpenAI·Toss 키, Supabase 비밀키, DB 접속 문자열이 있다. `.env.example`은 걸리지 않는다 |
| `*prisma migrate reset*`, `*--force-reset*`, `*--accept-data-loss*` deny | 모두 DB를 지운다 |
| `*dropdb*`, `*DROP TABLE*`, `*drop table*`, `*TRUNCATE*` deny | 같은 이유. 테스트는 코드 안의 `resetDb()`가 지우므로 커맨드로 지울 일이 없다 |
| `git push -f*`, `git push * -f*`, `git push *--force*` deny | 공유 브랜치 히스토리를 덮어쓴다 |
| `*supabase.co*`, `*supabase.com*` deny | Preview와 Production DB가 Supabase에 있다. 로컬·테스트 DB는 `localhost`라 막히지 않는다 |
| allow: 검사 커맨드(typecheck, test, lint, build, vitest, playwright, `scripts/*.sh`), 읽기 전용 git·gh | 수정 → 검사 루프가 매번 승인을 묻지 않게 한다. 쓰는 git, `gh pr create`, `prisma migrate dev`는 일부러 넣지 않았다 |

**한계.** Bash 규칙은 커맨드 텍스트만 본다. `bash -c '…'`처럼 다른 형태로 부르면 걸리지 않는다. 보안 경계가 아니라
흔한 실수를 막는 장치다. `TRUNCATE` 규칙은 `grep -rn TRUNCATE` 같은 검색도 막는다(그때는 Grep 툴을 쓴다).
`&&`로 이은 커맨드는 한 문자열로 보므로 `git push`와 `--force`가 한 줄에 함께 있으면 거부된다. push는 다른 커맨드와
묶지 않는다. 허용 목록은 워크스페이스를 신뢰한 뒤에만 적용된다(deny는 항상 적용).

## 4. 훅 — `.claude/settings.json` `hooks`, 스크립트는 `.claude/hooks/`

| 이벤트 | 파일 | 왜 있는가 |
|---|---|---|
| PreToolUse `Edit\|Write\|MultiEdit` | `protect-migrations.sh` | 커밋된 마이그레이션은 preview·production에 적용되고 Prisma가 체크섬을 검사한다. 고치면 `migrate deploy`가 멈춘다. git에 없는 폴더(`--create-only` 직후 백필 단계)만 허용하고, 나머지는 exit 2로 막는다 |
| PostToolUse `Edit\|Write\|MultiEdit` | `server-rules.sh` | `workbridge-server/src/**/*.ts`에 **방금 쓴 텍스트**에서 `console.`, 서비스·작업 핸들러의 `new Date()`, 호스트 시간대 getter/setter를 찾아 exit 2로 알린다. 파일 전체가 아니라 쓴 텍스트만 보는 것은 문서화된 기존 예외가 매번 다시 걸리지 않게 하려는 것이다 |
| Stop | `stop-check.sh` | HEAD 이후 서버 `.ts`가 바뀌었으면 `npm run typecheck`, 클라이언트 `src/`가 바뀌었으면 `npm run lint`. 실패하면 마지막 30줄을 돌려주고 exit 2. `stop_hook_active`가 true면 바로 통과한다(무한 루프 방지) |

**한계.** PostToolUse 훅은 편집이 일어난 뒤에 알린다. 막지 않고 고치게 한다. 텍스트 패턴이라 `req.user`나
`deletedAt: null` 같은 의미 규칙은 잡지 못한다. 훅 스크립트는 `jq`가 필요하다.

**서버 테스트 스위트는 Stop 훅에서 돌리지 않는다.** 실제 Postgres가 필요하고 한 번에 약 90초 걸린다. DB가 없는
환경에서는 매번 실패해 Claude를 붙잡는다. 파일 단위 테스트는 Claude가 `npx vitest run`으로 돌리고, 전체는 CI가 돌린다.

## 5. 스킬 — `.claude/skills/<name>/SKILL.md`

| 스킬 | 왜 있는가 |
|---|---|
| `run-workbridge` | 로컬 Postgres, `.env` 두 개, 마이그레이션, 시드, dev 서버 두 개를 띄우는 절차가 길다. API 스모크(`drive.sh`), 스크린샷, E2E 순서로 확인한다. 로그인 제한(규칙 10) 때문에 `RATE_LIMIT_ENABLED=false`, Supabase는 `localhost` 스텁 |
| `fix-divergence` | 남은 불일치(D3, D5, D6, D8–D22)를 하나씩 고치는 반복 작업. 핀 찾기 → 뒤집어 실패 확인 → 기존 스타일대로 수정 → Resolved로 이동 → `docs/API.md` |
| `add-endpoint` | 확장 라우트 하나에 손댈 곳이 아홉 군데다. 명세 → zod → 서비스 → 얇은 컨트롤러 → 가드 → `PROTECTED_ROUTES`·`guardedMutations` → 테스트 → 문서 |
| `db-migration` | 스키마 변경 뒤에 빠뜨리기 쉬운 후속 작업이 많다(`db:generate`, `TABLES`, `seed.js`, `DATABASE.md`) |
| `pre-pr-review` | `/code-review`와 `REVIEW.md` 번호 항목으로 diff를 보고, 국소적인 것만 고치고, 핀 뒤집기·기존 컨트롤러 개조·마이그레이션 수정은 사람에게 넘긴다. `allowed-tools`로 쓸 수 있는 커맨드를 묶었다 |

**한계.** 스킬은 설명이 요청과 맞을 때만 불린다. 스킬 전체를 끝까지 실행하는 자동 테스트는 없다.

## 6. 리뷰 기준 — `REVIEW.md`

로컬 `pre-pr-review`와 CI 리뷰어가 같은 번호 항목을 읽는다. 항목마다 규칙 한 줄, 이 코드베이스의 근거
(D1·D4·D12·D13·D19·D21·D22, M3/M5, NC9, PA7/S17/PF8 등), diff에서 확인하는 방법이 있다.

## 7. MCP — `.mcp.json`

Playwright MCP 서버(프로젝트 설치 범위). 클라이언트에는 단위 테스트가 없어서 UI 변경은 실제 브라우저로 봐야 한다.

## 두지 않은 것

- **서브에이전트 정의** — 반복해서 맡기는 작업이 아직 없다. 리뷰는 `/code-review`와 `REVIEW.md`로 충분하다.
- **테스트를 돌리는 훅** — 실제 DB와 90초가 필요하다. Stop 훅은 정적 검사만 한다.
- **포매터/린터 PostToolUse 훅** — Prettier 설정이 없고, 클라이언트 lint는 Stop 훅에서 한 번 돈다.
- **외부 리뷰 봇** — 같은 `REVIEW.md`를 읽는 Claude 리뷰어를 CI에 둔다. 기준이 두 곳으로 갈라지지 않게 한다.
- **`req.user`, `deletedAt: null`, `notify()`를 검사하는 훅** — 텍스트 패턴으로는 오탐이 많다. rules, `REVIEW.md`, 중앙 매트릭스 테스트가 맡는다.
- **소문자 `truncate` deny** — 같은 이름의 유닉스 커맨드가 있다.
- **샌드박스 설정** — 목적이 실수 방지라 OS 수준 격리는 넣지 않았다.
