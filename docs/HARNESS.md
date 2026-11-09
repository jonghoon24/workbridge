# 하네스 구성

이 리포지토리에서 Claude Code가 일할 때 쓰는 하네스를 정리한다. 요소마다 파일, **이 코드베이스의 어떤 규칙이나
사고 때문에 있는지**, 한계를 적는다. 규칙의 근거는 `docs/domain/`(제품 규칙), OpenAPI 문서, GitHub 이슈(알려진 버그와 결정), 코드다.

## 1. 지침 파일 — `CLAUDE.md`

모든 세션과 CI 리뷰어가 매번 읽는다. 그래서 안내판 역할만 한다: 제품 한 문단, 패키지 두 개, 커맨드, 어떤 문서를
언제 읽을지, 테스트가 무엇을 단언하는지 한 문단, 언어·커밋 컨벤션 두 줄, 그리고 바로 사고가 나는 "함정" 11개
(`import 'dotenv/config'`가 첫 import, 라우터 마운트 순서, `GET /api/projects`가 행을 씀, 공개 핸들러의 `req.user`,
응답이 OpenAPI 스키마와 맞아야 함, `Promise<void>` 금지 등). 상세 구조는 `docs/ARCHITECTURE.md`로, 경로별 지시는
rules로 보냈다. 80줄 안팎으로 유지한다.

## 2. 경로별 rules — `.claude/rules/*.md`

`paths:` 프론트매터에 맞는 파일을 읽거나 고칠 때만 컨텍스트에 들어온다.

| 파일 | 불러오는 경로 | 왜 있는가 |
|---|---|---|
| `server-layers.md` | `workbridge-server/src/**/*.ts` | 기존/확장 레이어 혼재는 의도된 것이고 이전은 #40에서 따로 한다. 새 라우트의 가드 체인과 OpenAPI 등록(`npm run openapi`), 트랜잭션 안 P2002 금지(Postgres가 트랜잭션을 이미 중단했다), `lockUserRow` 첫 문장 |
| `money-time.md` | 서비스, 작업, 스키마, `lib/money.ts`·`time.ts`, 결제·마일스톤·정산 컨트롤러 | 수수료·부가세·반올림은 `lib/money.ts`에만(인라인 계산은 1원 어긋남). CI·Vercel은 UTC라 호스트 시간대 함수는 기기마다 답이 다르다 |
| `jobs.md` | `src/jobs/**`, 서비스, `internal.controller.ts` | 트랜잭션 아웃박스, `create`+P2002 catch가 트랜잭션 전체를 중단시키는 문제, 운영은 15분 크론, 지급·메일 플래그 |
| `notifications-logging.md` | `workbridge-server/src/**/*.ts` | 알림은 `notify()`만(채널 정책과 수신자 설정이 거기서 적용된다). 스위트가 "500은 한 번만 error 로그"를 단언한다. 요청 body·query·헤더를 통째로 로그에 넣지 않는다(계좌번호·토큰이 운영 로그에 남는다) |
| `tests.md` | `workbridge-server/test/**`, `vitest.config.ts`, `docs/domain/**` | 테스트는 현재 코드가 아니라 의도를 단언하고 알려진 버그는 이슈로만 추적, 모든 응답의 OpenAPI 적합성 검사(새 상태 코드·필드는 문서부터), 실제 Postgres, 팩토리, 가짜 타이머 금지, 공통 관심사는 중앙 매트릭스에서 한 번 |
| `prisma.md` | `workbridge-server/prisma/**`, `docs/DATABASE.md` | 적용된 마이그레이션 불변, `seed.js`는 CommonJS, `deletedAt: null`(이 필터 누락이 #14, #16의 원인) |
| `client.md` | `workbridge-client/**` | JSX 유지, `lib/api.js`만, `middleware.js`는 쿠키 존재만 봄, 문구를 바꾸면 E2E도 함께 |
| `deploy.md` | `vercel.json`, `index.ts`, `env.ts`, `package.json`, 워크플로, `DEPLOYMENT.md`, `ENV.md` | `vercel.json`의 진입점 두 곳, `dist/` 없음(Prisma 생성은 `postinstall`), Preview/Production이 서로 다른 Supabase 프로젝트, 원격 마이그레이션은 `migrate.yml`만 |

**한계.** 경로가 맞는 파일을 읽어야 들어온다. 파일을 읽지 않고 답하는 질문에는 rules가 없다.

## 3. 권한 규칙 — `.claude/settings.json` `permissions`

| 규칙 | 왜 있는가 |
|---|---|
| `Read(**/.env)` 등 `.env` 계열 deny | 서버 `.env`에 JWT 비밀키, OpenAI·Toss 키, Supabase 비밀키, DB 접속 문자열이 있다. Read deny는 같은 파일의 **Write/Edit와 Bash의 `grep … .env`도 막는다** — 그래서 `run-workbridge`의 `.env` 만들기는 사람이 한다. `.env.example`은 걸리지 않는다 |
| `*prisma migrate reset*`, `*--force-reset*`, `*--accept-data-loss*` deny | 모두 DB를 지운다 |
| `*dropdb*`, `*DROP TABLE*`, `*drop table*`, `*TRUNCATE*` deny | 같은 이유. 테스트는 코드 안의 `resetDb()`가 지우므로 커맨드로 지울 일이 없다 |
| `git push -f*`, `git push * -f*`, `git push *--force*` deny | 공유 브랜치 히스토리를 덮어쓴다 |
| `*supabase.co*`, `*supabase.com*` deny | Preview와 Production DB가 Supabase에 있다. 로컬·테스트 DB는 `localhost`라 막히지 않는다 |
| `gh workflow run *seed*` deny | `seed.yml`은 원격(프리뷰·운영) DB의 모든 테이블을 비우고 시드로 되돌린다. `confirm=seed`는 사람용 확인이라 에이전트는 그대로 넣을 수 있다 |
| `*vercel env pull*`, `*vercel pull*` deny | Vercel 환경변수(운영 비밀값 포함)를 로컬 파일로 내려받는다. 내려받은 파일은 위 `.env` deny 밖에 놓일 수 있다 |
| `*vercel*--prod*` deny | 로컬에서 운영에 직접 배포한다. 운영 배포는 `main` 머지 → Vercel Git 연동으로만 한다 |
| allow: 검사 커맨드(typecheck, test, lint, build, vitest, `playwright test`·`playwright cli`, `scripts/*.sh`), 읽기 전용 git(`status`·`diff`·`log`·`show`·`ls-files`·`rev-parse`, `git branch --show-current`, `git remote -v`)·gh | 수정 → 검사 루프가 매번 승인을 묻지 않게 한다. `git branch`·`git remote`는 정확한 읽기 커맨드만 허용한다(`git branch -D`, `git remote set-url`은 묻는다). 쓰는 git, `gh pr create`, `prisma migrate dev`는 일부러 넣지 않았다 |

**한계.** Bash 규칙은 커맨드 텍스트만 본다. `bash -c '…'`처럼 다른 형태로 부르면 걸리지 않는다. 보안 경계가 아니라
흔한 실수를 막는 장치다. `TRUNCATE`·`vercel pull` 규칙은 `grep -rn TRUNCATE` 같은 검색도 막는다(그때는 Grep 툴을 쓴다).
`&&`로 이은 커맨드는 한 문자열로 보므로 `git push`와 `--force`가 한 줄에 함께 있으면 거부된다. push는 다른 커맨드와
묶지 않는다. 허용 목록은 워크스페이스를 신뢰한 뒤에만 적용된다(deny는 항상 적용).

## 4. 훅 — `.claude/settings.json` `hooks`, 스크립트는 `.claude/hooks/`

| 이벤트 | 파일 | 왜 있는가 |
|---|---|---|
| PreToolUse `Edit\|Write\|MultiEdit` | `protect-migrations.sh` | 커밋된 마이그레이션은 preview·production에 적용되고 Prisma가 체크섬을 검사한다. 고치면 `migrate deploy`가 멈춘다. git에 없는 폴더(`--create-only` 직후 백필 단계)만 허용하고, 나머지는 exit 2로 막는다 |
| PostToolUse `Edit\|Write\|MultiEdit` | `server-rules.sh` | `workbridge-server/src/**/*.ts`에 **방금 쓴 텍스트**에서 `console.`, 서비스·작업 핸들러의 `new Date()`, 호스트 시간대 getter/setter(`get`/`set` + `Date`·`Day`·`Hours`·`Month`·`FullYear`, `toLocaleDateString`)를 찾아 exit 2로 알린다. `toLocaleString`은 금액 포맷과 겹쳐 넣지 않았다. 파일 전체가 아니라 쓴 텍스트만 보는 것은 문서화된 기존 예외가 매번 다시 걸리지 않게 하려는 것이다 |
| Stop | `stop-check.sh` | HEAD 이후 서버 `.ts`가 바뀌었으면 `npm run typecheck`, 클라이언트 `src/`가 바뀌었으면 `npm run lint -- --max-warnings=0`(CI와 같은 기준). 실패하면 마지막 30줄을 돌려주고 exit 2. `stop_hook_active`가 true면 바로 통과한다(무한 루프 방지) |

**한계.** PostToolUse 훅은 편집이 일어난 뒤에 알린다. 막지 않고 고치게 한다. 텍스트 패턴이라 `req.user`나
`deletedAt: null` 같은 의미 규칙은 잡지 못한다. 훅 스크립트는 `jq`가 필요하다.

**서버 테스트 스위트는 Stop 훅에서 돌리지 않는다.** 실제 Postgres가 필요하고 한 번에 약 90초 걸린다. DB가 없는
환경에서는 매번 실패해 Claude를 붙잡는다. 파일 단위 테스트는 Claude가 `npx vitest run`으로 돌리고, 전체는 CI가 돌린다.

## 5. 스킬 — `.claude/skills/<name>/SKILL.md`

| 스킬 | 왜 있는가 |
|---|---|
| `run-workbridge` | 로컬 Postgres, `.env` 두 개, 마이그레이션, 시드, dev 서버 두 개를 띄우는 절차가 길다. API 스모크(`drive.sh`), 스크린샷, E2E 순서로 확인하고, 화면 하나는 `npx playwright cli`로 직접 조작한다. 로컬 로그인이 모두 루프백 한 주소로 세어져 로그인 제한에 걸리므로 `RATE_LIMIT_ENABLED=false`, Supabase는 `localhost` 스텁 |
| `add-endpoint` | 확장 라우트 하나에 손댈 곳이 열 군데다. 도메인 규칙 → zod → 서비스 → 얇은 컨트롤러 → 가드 → OpenAPI 등록·`npm run openapi` → `PROTECTED_ROUTES`·`guardedMutations` → 테스트 → 문서 |
| `db-migration` | 스키마 변경 뒤에 빠뜨리기 쉬운 후속 작업이 많다(`db:generate`, `TABLES`, `seed.js`, `DATABASE.md`, 응답에 나가는 필드면 OpenAPI 응답 스키마) |
| `pre-pr-review` | `/code-review`와 `REVIEW.md` 번호 항목으로 diff를 보고, 국소적인 것만 고치고, 기존 테스트 단언 완화·기존 컨트롤러 개조·마이그레이션 수정은 사람에게 넘긴다. `allowed-tools`로 쓸 수 있는 커맨드를 묶었다 |

**한계.** 스킬은 설명이 요청과 맞을 때만 불린다. 스킬 전체를 끝까지 실행하는 자동 테스트는 없다.

## 6. 리뷰 기준 — `REVIEW.md`

로컬 `pre-pr-review`와 CI 리뷰어가 같은 번호 항목을 읽는다. 항목마다 규칙 한 줄, 이 코드베이스의 근거(실제로 난
버그와 그 이슈 번호 — 탈퇴한 사용자의 쓰기 #7, 동시 결제 생성의 500 #8·#17, 삭제된 프로젝트의 필터 누락 #14·#16 —
도메인 문서와 `docs/DATABASE.md`의 절), diff에서 확인하는 방법이 있다. 항목 번호는 바꾸지 않는다(`REVIEW #n`으로
참조된다).

## 7. GitHub 워크플로 — `.github/workflows/`

| 파일 | 트리거 | 왜 있는가 |
|---|---|---|
| `ci.yml` | PR, `main` 푸시 | 서버 typecheck·`prisma validate`·`openapi.json` 최신 검사·테스트(실제 Postgres 서비스 컨테이너), 클라이언트 lint(`--max-warnings=0`)·빌드. 로컬 Stop 훅이 돌리지 않는 전체 스위트를 여기서 돌린다 |
| `e2e.yml` | PR, `main` 푸시 | Playwright E2E. 클라이언트에 단위 테스트가 없어서 핵심 흐름은 브라우저로만 확인된다 |
| `claude-code-review.yml` | PR opened·synchronize·ready_for_review·reopened(드래프트 제외) | Claude가 `REVIEW.md`·`CLAUDE.md`와 바뀐 경로의 rules, PR 본문을 읽고 diff를 리뷰한다. 지적은 인라인 코멘트로 달고 `REVIEW.md` 위반에는 `REVIEW #n`을 붙인다. 푸시마다 다시 돌지만 자신이 이미 단 지적(`gh api …/pulls/<n>/comments`)은 다시 달지 않고, 실행마다 요약 코멘트 하나(새 지적 수와 REVIEW 항목별 건수, 이전 지적의 해결·남음)를 남긴다. 말투는 합니다체, `--max-turns 20`. 승인·변경 요청·코드 수정·푸시는 하지 않는다 — 머지 결정은 사람 몫이다 |
| `claude.yml` | 이슈·PR 코멘트, PR 리뷰·리뷰 코멘트의 `@claude` 멘션, 이슈 opened·assigned(제목이나 본문에 `@claude`) | 멘션에 답하거나, 작업을 맡아 새 브랜치에 커밋·푸시하고 PR 템플릿을 채운 **드래프트 PR**을 연다(이미 열린 PR에서는 그 브랜치에 푸시만). 저장소의 `CLAUDE.md`·rules·스킬을 그대로 읽는다. 의존성 설치·Prisma 생성 단계가 있어 허용 커맨드 typecheck·lint가 실제로 돈다. 그 밖의 허용은 읽기 전용 git, `gh pr view`·`gh pr diff`·`gh pr create`, `gh issue view`. DB가 없어 vitest는 허용하지 않는다(테스트는 PR의 `ci.yml`). 트리거한 사람에게 쓰기 권한이 있어야 돈다 |
| `migrate.yml` | `main` 푸시 중 `workbridge-server/prisma/migrations/**` 변경, 수동 | 원격 DB에 마이그레이션을 적용하는 유일한 경로. 프리뷰 → 운영 순서로 `prisma migrate deploy`, `concurrency: migrate`. 권한 규칙이 Supabase 접속을 막으므로 로컬 세션은 원격 DB에 닿지 못한다 |
| `seed.yml` | 수동 전용(`environment`, `confirm=seed`) | 프리뷰·운영 DB를 시드로 되돌린다. 모든 테이블을 비우므로 확인 입력이 있어야 돈다 |

두 Claude 워크플로는 구독 토큰 시크릿 `CLAUDE_CODE_OAUTH_TOKEN`으로 `anthropics/claude-code-action@v1`을 돌린다.

**`@claude`의 PR이 드래프트인 이유.** 액션의 기본 동작은 PR을 열지 않고 "Create PR" 링크만 남기는 것이다.
`claude.yml`은 `claude_args`의 `--append-system-prompt`로 그 지시를 덮어 `gh pr create --draft`로 PR을 직접 열게 한다.
드래프트는 `claude-code-review.yml`이 건너뛰고, 사람이 diff를 보고 **Ready for review**를 누르면 그 사람의
`ready_for_review` 이벤트로 AI 리뷰가 시작된다. 위임은 하되 리뷰 시작과 머지는 사람이 정한다. 그 뒤 `@claude`가 같은 PR에
커밋을 푸시하면 actor가 `claude[bot]`이라서, 리뷰 워크플로는 `allowed_bots: claude`로 이 앱 하나만 허용한다.

**한계.** CI 리뷰어도 `REVIEW.md`와 rules가 다루는 것만 일관되게 본다. 리뷰 코멘트는 머지를 막지 않는다.

## 8. MCP — `.mcp.json`

| 서버 | 왜 있는가 |
|---|---|
| Sentry(http, `https://mcp.sentry.dev/mcp`) | 운영·프리뷰 서버 오류를 Sentry 프로젝트 `workbridge-server`에서 조회해 원인을 찾고 고친다. 사용자마다 OAuth 로그인이 필요하다 |

## 두지 않은 것

- **서브에이전트 정의** — 반복해서 맡기는 작업이 아직 없다. 리뷰는 `/code-review`와 `REVIEW.md`로 충분하다.
- **테스트를 돌리는 훅** — 실제 DB와 90초가 필요하다. Stop 훅은 정적 검사만 한다.
- **포매터/린터 PostToolUse 훅** — Prettier 설정이 없고, 클라이언트 lint는 Stop 훅에서 한 번 돈다.
- **CodeRabbit 같은 외부 리뷰 봇** — CI 리뷰어는 같은 `REVIEW.md`를 읽는 Claude(`claude-code-review.yml`)다. 기준이 두 곳으로 갈라지지 않는다.
- **`req.user`, `deletedAt: null`, `notify()`를 검사하는 훅** — 텍스트 패턴으로는 오탐이 많다. rules, `REVIEW.md`, 중앙 매트릭스 테스트가 맡는다.
- **소문자 `truncate` deny** — 같은 이름의 유닉스 커맨드가 있다.
- **샌드박스 설정** — 목적이 실수 방지라 OS 수준 격리는 넣지 않았다.
- **Playwright MCP** — 화면 확인은 클라이언트의 Playwright(1.65)에 들어 있는 `npx playwright cli`로 한다. 터미널 툴이라 MCP 툴 정의와 큰 응답으로
  컨텍스트를 채우지 않고, 접근성 스냅샷의 ref(`e5`)로 요소를 조작하며, 버전이 리포지토리의 lockfile에 고정된다.
  `-s=<세션>`으로 병렬 작업이 서로의 브라우저를 건드리지 않는다. 사용법: `.claude/rules/client.md`, `run-workbridge` 스킬.
