# 하네스 구성

이 저장소에서 Claude Code가 일할 때 쓰는 하네스의 구성 요소를 정리한다. 요소마다 **이 코드베이스의
어떤 규칙이나 사고 때문에 있는지**와 **어떻게 확인했는지**를 적었다. 규칙의 근거는
`docs/BEHAVIOR.md`(명세, D번호는 "Known divergences" 표)와 코드다.

확인은 하네스 워크트리에서 `claude -p`(Claude Code 2.1.318)로 실제 세션을 돌려 했다. `-p`는
권한을 물어볼 수 없어서, 허용 목록 밖 명령은 `This command requires approval`, deny 규칙에 걸린
명령은 `Permission to use Bash with command … has been denied.`로 결과가 갈린다. 아래 "확인"
열의 인용은 그 출력이다.

## 1. 지침 파일

| 요소 | 파일 | 왜 있는가 | 확인 |
|---|---|---|---|
| 루트 지침 | `CLAUDE.md` (90줄 이하) | 모든 세션과 CI 리뷰어가 매번 읽는다. 그래서 제품 설명, 두 패키지, 명령, 구조 몇 줄, 그리고 바로 사고가 나는 "함정"만 남겼다: `import 'dotenv/config'`가 첫 import(모듈 평가 때 `process.env`를 읽는 모듈들), 라우터 마운트 순서(`users`→`profile`, `projects`→`applications`, 먼저 마운트된 쪽이 이긴다), `GET /api/projects`가 행을 쓴다(지연 수명주기 스윕, 규칙 7), 공개 핸들러 12개의 `req.user`는 `undefined`, 핸들러에 `Promise<void>` 금지 | 이전 77줄(긴 줄로 14.7KB)을 옮기고 나머지는 rules로 보냈다 |
| 명세 지시 | `CLAUDE.md` 머리 | `docs/BEHAVIOR.md`가 오라클이고 현재 동작은 명세가 아니라는 것. 어긋난 곳은 D번호와 `it.fails` 핀으로 표시돼 있다 | — |

## 2. 경로별 rules (`.claude/rules/*.md`, `paths:` 프론트매터)

해당 경로의 파일을 Read/Edit/Write할 때만 컨텍스트에 들어온다. 루트 지침을 짧게 유지하는 장치다.

| 요소 | 파일 | 불러오는 경로 | 왜 있는가 |
|---|---|---|---|
| 서버 레이어 | `server-layers.md` | `workbridge-server/src/**/*.ts` | 기존/확장 레이어 혼합은 의도된 것(규칙 12). 기존 컨트롤러에 zod·서비스·`requireActiveUser`를 붙이면 D12 핀(`soft-delete.test.ts` `mutations`)이 예기치 않게 통과해 스위트가 깨진다. 새 라우트 레시피, 마운트 순서, `AppError`/`errorHandler`(인자 4개 유지), 트랜잭션 안 P2002 금지(D4 수정 방식), `lockUserRow` 첫 문장. "기존 컨트롤러에 추가하지 않는다" 규칙은 따로 지울 수 있게 한 줄로 뒀다 |
| 금액과 시간 | `money-time.md` | 서비스, 잡, 스키마, `lib/money.ts`·`time.ts`, 결제·마일스톤·정산 컨트롤러 | M3/M5/M7 금액 규칙은 `lib/money.ts`에만 있다. 달력은 고정 UTC+9(`lib/time.ts`, 규칙 11). CI·Vercel은 UTC라 호스트 시간대 함수는 기기마다 답이 다르다. `now`를 인자로 받아야 `runJobs(now)`로 테스트한다 |
| 작업 큐 | `jobs.md` | `src/jobs/**`, 서비스, `internal.controller.ts` | 트랜잭션 아웃박스(`enqueueJob(tx, …)`), `dedupeKey`=`createMany({ skipDuplicates })`. `create`+P2002 catch는 트랜잭션 전체를 중단시킨다. 핸들러는 `ctx.now`. 운영에는 워커가 없다 |
| 알림과 로그 | `notifications-logging.md` | `workbridge-server/src/**/*.ts` | 알림은 `notify()`만(NC9: 인앱 행·`EmailDelivery`·잡을 한 트랜잭션에). `error` 레벨은 500과 잡 실패 전용 — 스위트가 `console.error` 스파이로 "500은 한 번 로그"를 단언한다(규칙 1, 9) |
| 테스트 | `tests.md` | `workbridge-server/test/**`, `vitest.config.ts`, `docs/BEHAVIOR.md` | 실제 Postgres(모킹 없음), 팩토리, `runJobs`, 가짜 타이머 금지, `it.fails` 핀은 고침과 함께만 뒤집기, 401/403은 `authorization.test.ts`, 소프트 삭제는 `soft-delete.test.ts`에서 한 번만, Supabase `vi.mock`은 파일 맨 위, `setup.ts`는 앱을 import하지 않는다 |
| Prisma | `prisma.md` | `workbridge-server/prisma/**`, `docs/DATABASE.md` | 적용된 마이그레이션 불변, `db:generate`, `seed.js`는 CommonJS 유지, `deletedAt: null`(D1, D19, D21) |
| 클라이언트 | `client.md` | `workbridge-client/**` | JSX 유지, `lib/api.js`만(인증 폼은 `authApi.js` — 갱신 인터셉터가 없어 로그인 실패가 갱신 루프를 만들지 않는다), 브라우저 base URL `''`/SSR `API_URL`, `middleware.js`는 쿠키 존재만 본다, 문구 변경은 E2E 수정과 함께, 검사는 `lint`·`build`·`bash scripts/e2e.sh`·`scripts/screenshots.mjs` |
| 배포 | `deploy.md` | `vercel.json`, `index.ts`, `env.ts`, `package.json`, 워크플로, `DEPLOYMENT.md`, `ENV.md` | `vercel.json`이 진입점을 두 번 하드코딩, `dist/` 없음, Preview/Production이 서로 다른 Supabase 프로젝트, 마이그레이션은 main 머지 때 CI가 두 DB에 적용, 운영에는 잡 워커가 없다 |

**확인.** 같은 질문을 두 세션에 했다.
- `claude -p "Do not use any tools. … is there any instruction in your context that mentions 'authApi.js'?"` → `No. Nothing in my context mentions authApi.js.`
- `claude -p "Read workbridge-client/src/lib/api.js … is there any instruction … 'authApi.js'?"` → `Yes. One instruction mentions it, and it arrived only after the Read call. … the path-scoped rules file .claude/rules/client.md.`
- 시간대 규칙 확인(아래 훅 4)에서도 `milestones.service.ts`를 읽은 세션이 `money-time.md`를 근거로 `getDate()`/`new Date()` 대신 `kstDateString(…)`과 `now` 인자로 고쳐 썼다. 훅이 걸리기 전에 rule이 먼저 막은 사례다.

## 3. 권한 규칙 (`.claude/settings.json` → `permissions`)

| 규칙 | 왜 있는가 | 확인 (`claude -p --permission-mode default …`) |
|---|---|---|
| `Read(**/.env)`, `**/.env.local`, `**/.env.test`, `**/.env.*.local`, `**/.env.production*` deny | 서버 `.env`에는 JWT 비밀키, OpenAI·Toss 키, Supabase 비밀키와 DB 접속 문자열이 있다. Read deny는 `cat`·`grep` 같은 Bash 파일 명령과 Edit/Write에도 적용된다. `.env.example`은 패턴에 걸리지 않는다 | `"Read workbridge-server/.env and print it"` → Read 결과 `File is in a directory that is denied by your permission settings.`, 답변 `I can't print it. The project's own permission settings block reading that file`. `"Run this exact shell command …: cat workbridge-server/.env"` → `Permission to use Bash with command cat workbridge-server/.env has been denied.` 출력에 더미 비밀값 0회. `"Read workbridge-server/.env.example …"` → 파일 내용을 읽고 `The first variable … is PORT` |
| `Bash(*prisma migrate reset*)`, `*--force-reset*`, `*--accept-data-loss*` deny | 모두 DB를 지운다. 로컬 개발 DB에는 시드와 수동 테스트 데이터가 있고, 원격 DB에서 실행되면 사고다 | `"run: npx prisma migrate reset --force (run it inside workbridge-server)"` → `cd … && npx prisma migrate reset --force 2>&1 has been denied.` 세 번 시도 모두 거부, 답변 `The reset did not run.` |
| `Bash(*dropdb*)`, `*DROP TABLE*`, `*drop table*`, `*TRUNCATE*` deny | 같은 이유. 테스트 스위트는 `resetDb()`가 코드 안에서 TRUNCATE하므로(`assertTestDatabase`가 URL에 "test"가 있는지 확인) 명령줄에서 직접 지울 일이 없다 | `"Run …: psql -d workbridge_test -c 'TRUNCATE TABLE \"User\" CASCADE'"` → `… has been denied.` |
| `Bash(git push -f*)`, `git push * -f*`, `git push *--force*` deny | 공유 브랜치 이력을 덮어쓴다. 커밋·푸시는 사용자가 요청할 때만 한다 | `"Run this exact command: git push --force origin work/harness"` → `git push --force origin work/harness has been denied.` (같은 세션의 `git fetch`는 `requires approval` — deny와 승인 대기가 구분된다) |
| `Bash(*supabase.co*)`, `*supabase.com*` deny | Preview와 Production DB는 각각 Supabase 프로젝트에 있다. 명령에 그 접속 문자열이 들어간다는 것은 실제 DB를 건드리려 한다는 뜻이다. **로컬 DB와 테스트 DB는 `localhost`라서 로컬 작업은 막히지 않는다.** 그래서 `run-workbridge` 스킬의 `.env` 예시도 `SUPABASE_URL=http://localhost:54321`(업로드 스텁)로 바꿨다 | `"Run …: psql 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres' -c 'select 1'"` → `… has been denied.`, 답변 `no connection to the Supabase host was attempted` |
| allow: 서버 `npm run typecheck|test|lint`, `npm test`, `npx vitest run`, `npx prisma validate|generate`, 클라이언트 `npm run lint|build`, `npx playwright test`, `bash scripts/e2e.sh`, `bash scripts/test-db.sh`, 읽기 전용 git, `gh pr view|pr checks|issue view|run view|run list` | 수정 → 검사 루프가 매번 승인을 묻지 않게 한다. 쓰는 git·`gh pr create`·`npx prisma migrate dev`는 일부러 넣지 않았다 | **`-p`에서는 확인하지 못했다.** 이 워크스페이스는 신뢰 대화상자를 거치지 않아 `Ignoring 24 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.`가 뜬다(deny는 그대로 적용된다). 대화형으로 한 번 열어 신뢰하면 적용된다 |

**한계.** Bash 규칙은 명령 텍스트를 본다. `bash -c '…'`나 `/usr/bin/…`처럼 다른 형태로 부르면 걸리지
않는다(공식 문서의 "What a Bash rule doesn't match"). 보안 경계가 아니라 흔한 실수를 막는 장치다.
`TRUNCATE` 규칙은 `grep -rn TRUNCATE test/` 같은 검색 명령도 막는다. 그럴 때는 Grep 도구를 쓴다.

## 4. 훅 (`.claude/settings.json` → `hooks`, 스크립트는 `.claude/hooks/`)

| 훅 | 파일 | 왜 있는가 | 확인 |
|---|---|---|---|
| PreToolUse `Edit\|Write\|MultiEdit` | `protect-migrations.sh` | 커밋된 마이그레이션은 main 머지 때 CI가 preview·production에 적용하고 Prisma가 체크섬을 검사한다. 수정하면 두 DB에서 `migrate deploy`가 멈춘다. git에 없는 폴더(`migrate dev --create-only` 직후, 백필 SQL을 넣는 단계)만 허용한다. exit 2 + 한 줄 사유 | `claude -p --permission-mode acceptEdits "Using the Edit tool only …, append the line '-- harness test' to the end of BOTH …/20260312030411_init/migration.sql and …/20991231000000_harness_probe/migration.sql"` → 첫 파일 `PreToolUse:Edit hook error: … Blocked: workbridge-server/prisma/migrations/20260312030411_init/migration.sql is an applied (committed) migration and must not be edited — change prisma/schema.prisma and run \`npx prisma migrate dev --name <name>\` …`, 미추적 탐침 폴더는 편집 성공 |
| PostToolUse `Edit\|Write\|MultiEdit` | `server-rules.sh` | `workbridge-server/src/**/*.ts`에 **방금 쓴 텍스트**에서 ① `console.` ② 서비스·잡 핸들러의 `new Date()` ③ `getDate(`·`getHours(`·`getDay(`·`setHours(`·`setDate(`·`toLocaleDateString(`를 찾는다. 규칙과 쓸 lib를 적어 exit 2. 편집은 이미 일어났으므로 막지 않고 고치게 한다. `lib/time.ts`·`lib/logger.ts`(규칙을 구현하는 파일)와 `jobs/cli.ts`(출력이 목적)는 제외. 파일 전체가 아니라 쓴 텍스트만 보는 이유: 문서화된 기존 예외(`googleCallback`의 `console.error`, AI 프롬프트의 `toLocaleDateString`)가 그 파일을 고칠 때마다 다시 걸리지 않게 | ① `"Add a quick console.log debug line at the start of the try block of createReview …"` → 훅 메시지 `PostToolUse:Edit hook blocking error … console.* is not used in server code, temporary debug lines included → replace it with logger.debug…`를 받고 스스로 `logger.debug('createReview called', { contractId: req.body.contractId })`로 바꿨다. 첫 버전 메시지("…the suite counts console.error calls")로는 "console.log는 괜찮다"며 그대로 두어서 문구를 단호하게 고쳤다. ② ③ `"Add an exported helper isDueToday … compares dueDate.getDate()… with new Date()"` → rule이 먼저 막아 `isDueToday(dueDate: Date, now: Date)` + `kstDateString`으로 작성. 스크립트 단독 실행으로 세 경고가 모두 나오는 것도 확인 |
| Stop | `stop-check.sh` | HEAD 이후 바뀐 파일(추적+미추적)에 `workbridge-server/**/*.ts`가 있으면 `npm run typecheck`(src와 test 모두), `workbridge-client/src/**`가 있으면 `npm run lint`. 실패하면 마지막 30줄을 stderr로 내고 exit 2 → Claude가 계속 일한다. 무한 루프를 막으려고 입력의 `stop_hook_active`가 true면 바로 통과한다(그래서 두 번째 수정은 다시 검사하지 않는다). 각각 1초 안팎이다 | `"In workbridge-server/src/lib/money.ts, add a required second parameter mode: 'floor' \| 'round' to wholeWon … Edit just that function"` → 종료 시 훅이 `Stop check failed: workbridge-server npm run typecheck. … src/services/milestones.service.ts(89,26): error TS2345 …`를 돌려주자 호출부 9곳(`milestones.service.ts` 6, `test/money.test.ts` 3)을 고치고 끝냈다: `The stop hook's typecheck then flagged the nine existing callers, so I updated them too.` 사용자가 "고치지 말라"고 한 세션에서는 실패를 보고만 했다 |

**서버 테스트 스위트는 Stop 훅에서 돌리지 않는다.** 실제 Postgres(`workbridge_test`)가 필요하고 한
번에 약 90초 걸린다. DB가 없는 환경에서는 매번 실패해 Claude를 붙잡게 된다. 스위트는 Claude가
`npx vitest run test/<file>.test.ts`로 직접 돌리고(허용 목록에 있다), 전체는 CI가 돌린다.

훅 스크립트는 `jq`가 필요하다(macOS에는 `/usr/bin/jq`가 있다).

## 5. 스킬 (`.claude/skills/<name>/SKILL.md`)

| 스킬 | 왜 있는가 | 담긴 이 코드베이스 규칙 |
|---|---|---|
| `run-workbridge` | 두 패키지를 띄우고 확인하는 절차가 길다(로컬 Postgres, 두 `.env`, 마이그레이션, 시드, 두 dev 서버) | API 스모크는 `drive.sh`(health, 목록, 시드 로그인, 같은 출처 프록시). 스크린샷은 `workbridge-client/scripts/screenshots.mjs`, E2E는 `bash scripts/e2e.sh` — 이전 raw Chrome 경로는 비어 있지 않은 PNG만 확인해 지웠다. 로그인 제한 20회/15분(규칙 10) 때문에 `RATE_LIMIT_ENABLED=false`, Supabase는 `localhost` 스텁 |
| `fix-divergence` | BEHAVIOR.md의 남은 불일치(D3, D5, D6, D8–D22)를 하나씩 고치는 반복 작업 | 행 읽기 → `[Dn]` 핀 찾기 → `it.fails`→`it`로 바꿔 실패 확인 → 명세대로 수정(기존 컨트롤러 스타일 유지) → 파일·전체 실행 → D1/D2/D4/D7 형식으로 "Resolved"로 이동 → `docs/API.md` 문장 수정. 다른 핀이 같이 통과하면 함께 뒤집는다 |
| `add-endpoint` | 확장 라우트 한 개에 손대는 곳이 9군데다 | BEHAVIOR.md 절(번호 매긴 규칙) → zod → 서비스(트랜잭션, `lockUserRow`, `notify`, `enqueueJob`) → 얇은 컨트롤러 → `authenticate → requireActiveUser → requireRole → validate` → `PROTECTED_ROUTES`와 `guardedMutations`(절대 `mutations` 아님) → 팩토리 테스트 → `docs/API.md` |
| `db-migration` | 스키마 변경 뒤에 빠뜨리기 쉬운 후속 작업이 많다 | `migrate dev --name` → `db:generate` → typecheck → `test/helpers/db.ts`의 `TABLES` → `seed.js`(CommonJS) → `docs/DATABASE.md` 마이그레이션 표 → 적용된 마이그레이션 수정 금지 → CI가 main 머지 때 preview·production에 적용 |
| `pre-pr-review` | 사용자 수준(`~/.claude/skills`)에 있던 것을 저장소로 옮겨 팀이 같이 쓴다 | `/code-review medium --fix` + `REVIEW.md` 번호 항목 점검 → 수정 커밋 → 건너뛴 지적은 "사람이 확인해야 할 항목" → 승인 후 `.github/PULL_REQUEST_TEMPLATE.md`로 `gh pr create`. 핀 뒤집기·기존 컨트롤러 개조·마이그레이션 수정은 스스로 고치지 않고 보고한다. `allowed-tools`로 쓸 수 있는 명령을 묶었다 |

**확인.** 스킬 본문은 실제 파일(`test/soft-delete.test.ts`의 `Mutation` 모양, `test/authorization.test.ts`의 `RouteSpec`, `validate()`가 `res.locals.query`에 넣는 것, BEHAVIOR.md의 Resolved 표 열)을 읽고 맞췄다. 스킬을 끝까지 실행하는 테스트는 하지 않았다(DB와 실제 수정이 필요하다).

## 6. 리뷰 기준

| 요소 | 파일 | 왜 있는가 |
|---|---|---|
| 번호 매긴 리뷰 기준 14개 | `REVIEW.md` | 로컬 `pre-pr-review`와 CI 리뷰어가 같은 기준을 읽는다. 항목마다 규칙 한 줄, 이 코드베이스의 근거(D1·D4·D12·D13·D19·D21·D22, M3/M5, NC9, PA7/S17/PF8, 규칙 1·5·9·11·12), diff에서 확인하는 방법. 한국어(리뷰 코멘트가 한국어). "기존 컨트롤러에 zod/서비스/`requireActiveUser`를 추가하지 않는다"는 2번 항목으로 따로 뒀다 |

## 7. MCP

| 요소 | 파일 | 왜 있는가 | 확인 |
|---|---|---|---|
| Playwright MCP (`npx @playwright/mcp@latest`) | `.mcp.json` (프로젝트 범위) | 클라이언트에는 단위 테스트가 없고 `npm run build`가 유일한 자동 검사다. UI 변경은 실제 브라우저로 봐야 한다 | `claude -p` 초기화 메시지에 `{"name":"playwright","status":"connected","source":"project"}` |

## 두지 않은 것

- **서브에이전트 정의(`.claude/agents/`)** — 반복되는 위임 작업이 아직 없다. 리뷰는 `/code-review`와 `REVIEW.md`로 충분하고, 정의를 늘리면 유지할 지침만 늘어난다.
- **테스트를 돌리는 훅** — 위에 적은 대로 실제 DB와 90초가 필요하다. Stop 훅은 1초대 정적 검사만 한다.
- **PostToolUse 포매터/린터 훅** — 저장소에 Prettier 설정이 없고, 클라이언트 lint는 Stop 훅에서 한 번 돈다. 편집마다 돌리면 느리기만 하다.
- **CodeRabbit 같은 외부 리뷰 봇** — 같은 기준(`REVIEW.md`)을 읽는 Claude 리뷰어를 CI에 둔다. 기준이 두 곳으로 갈라지지 않게 한다.
- **`req.user`, `deletedAt: null`, `notify()` 사용을 검사하는 훅** — 텍스트 패턴으로는 오탐이 많다(공개 핸들러인지, 어떤 모델인지 알아야 한다). rules와 `REVIEW.md`, 그리고 중앙 매트릭스 테스트가 맡는다.
- **소문자 `truncate` deny** — 같은 이름의 유닉스 명령이 있고 SQL은 관례상 대문자로 쓴다.
- **샌드박스 설정** — Bash deny는 명령 텍스트만 본다는 한계가 있지만, 여기서는 실수 방지가 목적이라 OS 수준 격리는 넣지 않았다.
