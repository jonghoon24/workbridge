# 하네스 구성

이 리포지토리에서 Claude Code가 일할 때 쓰는 하네스를 정리한다. 요소마다 파일, **이 코드베이스의 어떤 규칙이나
사고 때문에 있는지**, 한계를 적는다. 각 요소의 실제 내용(지시문, 패턴, 허용 목록)은 그 파일이 원본이고 여기에 옮겨 적지 않는다.

## 1. 지침 파일 — `CLAUDE.md`

모든 세션과 CI 리뷰어가 매번 읽는다. 그래서 지도 역할만 한다: 제품 한 문단, 패키지 두 개, 커맨드, 어떤 문서를
언제 읽을지, 테스트 원칙, 언어·커밋 컨벤션, 그리고 어느 경로를 고치든 사고가 날 수 있는 함정. 특정 경로에서만
필요한 지시는 rules로, 상세 구조는 `docs/ARCHITECTURE.md`로 보낸다. 도구(권한, 훅, ESLint, tsc)가 이미 막고 그 오류가
이유를 알려 주는 것은 적지 않는다.

## 2. 경로별 rules — `.claude/rules/*.md`

`paths:` 프론트매터에 맞는 파일을 읽거나 고칠 때만 컨텍스트에 들어온다. 내용은 그 경로를 고칠 때의 명령문뿐이다.
서버 `src/`의 파일 하나를 고치면 여러 rule이 함께 들어오므로, 같은 규칙은 그중 한 파일에만 둔다.

| 파일 | 왜 있는가 |
|---|---|
| `server-layers.md` | 기존/확장 레이어가 섞여 있고 이전은 #40에서 따로 한다. 새 라우트의 가드 체인과 OpenAPI 등록, 공개 핸들러의 `req.user`(타입이 경고하지 않는다), 트랜잭션 아웃박스, 트랜잭션 안 P2002(Postgres가 트랜잭션을 이미 중단했다), 잠금 순서(`lockUserRow` 첫 문장, 시스템 메시지는 마지막 쓰기), raw SQL의 시각(9시간 어긋남) |
| `money-time.md` | 수수료·부가세·반올림은 `lib/money.ts`에만(인라인 계산은 1원 어긋남). CI·Vercel은 UTC, 개발 PC는 KST라 호스트 시간대 함수는 기기마다 답이 다르다. 테스트가 시간을 제어하도록 `now`를 인자로 |
| `jobs.md` | 작업 등록 위치, 멱등 핸들러, 외부로 보내는 작업의 플래그, 미래 `now`로 돌릴 때 수명주기 스윕이 프로젝트를 닫는 함정 |
| `notifications-logging.md` | 알림은 `notify()` 계열만(채널 정책과 수신자 설정이 거기서 적용된다). 요청 body·query·헤더를 통째로 로그에 넣지 않는다(계좌번호·토큰). 스위트가 "500은 한 번만 error 로그"를 단언한다 |
| `tests.md` | 단언을 약하게 바꾸지 않기, 버그로 보이는 동작을 고정하지 않기, 모든 응답의 OpenAPI 적합성 검사, 실제 Postgres, 가짜 타이머 금지, 공통 관심사는 중앙 매트릭스에서 한 번 |
| `prisma.md` | 새 테이블의 RLS(Supabase Data API), 새 `String[]` 컬럼의 `NULL` 원소 CHECK(Prisma `P2032`), `Float` 금액 부채, `seed.js`는 CommonJS |
| `client.md` | JSX 유지, `lib/api.js`만, 첨부 `PUT`에 토큰 금지, 문구를 바꾸면 E2E도 함께 |
| `deploy.md` | `vercel.json`의 진입점 두 곳과 `regions`, `dist/` 없음(Prisma 생성은 `postinstall`), 클라이언트 `vercel.json`의 자동 감지, 결제 우회·메일 로그의 운영 기본값 |

**한계.** 경로가 맞는 파일을 읽어야 들어온다. 파일을 읽지 않고 답하는 질문에는 rules가 없다.

## 3. 권한 규칙 — `.claude/settings.json` `permissions`

목록은 `settings.json`이 원본이다. 여기서는 각 묶음이 왜 있는지만 적는다.

| 묶음 | 왜 있는가 |
|---|---|
| `.env` 계열 Read deny | 서버 `.env`에 JWT 비밀키, 외부 서비스 키, DB 접속 문자열이 있다. Read deny는 같은 파일의 Write/Edit와 Bash의 `grep … .env`도 막는다 — 그래서 `run-workbridge`의 `.env` 만들기는 사람이 한다. `.env.example`은 걸리지 않는다 |
| DB를 지우는 커맨드 deny(`migrate reset`, `--force-reset`, `--accept-data-loss`, `dropdb`, `DROP TABLE`, `TRUNCATE`) | 로컬 개발 DB도 시드와 작업 상태를 잃는다. 테스트 DB는 코드 안의 `resetDb()`가 비우므로 커맨드로 지울 일이 없다 |
| 강제 push deny | 공유 브랜치 히스토리를 덮어쓴다 |
| `supabase.co`/`supabase.com` deny | Preview와 Production DB가 Supabase에 있다. 원격 DB 마이그레이션은 `migrate.yml`만 한다. 로컬·테스트 DB는 `localhost`라 막히지 않는다 |
| `seed.yml` 실행 deny | 원격 DB의 모든 테이블을 비우고 시드로 되돌린다. 워크플로의 `confirm=seed`는 사람용 확인이라 에이전트는 그대로 넣을 수 있다 |
| `vercel pull`·`vercel env pull` deny | 운영 비밀값을 로컬 파일로 내려받는다. 그 파일은 `.env` deny 밖에 놓일 수 있다 |
| `vercel … --prod` deny | 운영 배포는 `main` 머지 → Vercel Git 연동으로만 한다 |
| allow: 검사 커맨드, `npm run openapi`, 읽기 전용 git·gh | 수정 → 검사 루프가 매번 승인을 묻지 않게 한다. `npm run openapi`는 DB·환경변수·네트워크 없이 `openapi.json` 한 파일만 결정적으로 다시 쓴다. 쓰는 git, `gh pr create`, `prisma migrate dev`는 일부러 넣지 않았다(사람이 승인한다) |

**한계.** Bash 규칙은 커맨드 텍스트만 본다. `bash -c '…'`처럼 다른 형태로 부르면 걸리지 않는다. 보안 경계가 아니라
흔한 실수를 막는 장치다. `TRUNCATE`·`vercel pull` 규칙은 `grep -rn TRUNCATE` 같은 검색도 막는다(그때는 Grep 툴을 쓴다).
`&&`로 이은 커맨드는 한 문자열로 보므로 `git push`와 `--force`가 한 줄에 함께 있으면 거부된다. push는 다른 커맨드와
묶지 않는다. 허용 목록은 워크스페이스를 신뢰한 뒤에만 적용된다(deny는 항상 적용).

## 4. 훅 — `.claude/settings.json` `hooks`, 스크립트는 `.claude/hooks/`

| 이벤트 | 파일 | 왜 있는가 |
|---|---|---|
| PreToolUse `Edit\|Write\|MultiEdit` | `protect-migrations.sh` | 커밋된 마이그레이션은 preview·production에 적용되고 Prisma가 체크섬을 검사한다. 고치면 `migrate deploy`가 멈춘다. git에 없는 폴더(`--create-only` 직후 백필 단계)만 허용하고, 나머지는 exit 2로 막는다 |
| PostToolUse `Edit\|Write\|MultiEdit` | `server-rules.sh` | 서버 `src/`에 **방금 쓴 텍스트**에서 `console.`, 서비스·작업 핸들러의 `new Date()`, 호스트 시간대 getter/setter를 찾아 exit 2로 알린다. 파일 전체가 아니라 쓴 텍스트만 보는 것은 문서화된 기존 예외가 매번 다시 걸리지 않게 하려는 것이다. `toLocaleString`은 금액 포맷과 겹쳐 넣지 않았다 |
| PostToolUse `Edit\|Write\|MultiEdit` | `regen-openapi.sh` | 서버 `src/`를 고칠 때마다 `openapi.json`을 다시 만든다. 문서는 zod 스키마·OpenAPI 등록·라우트·Prisma enum에서 나와 어느 서버 파일이 바뀌어도 달라질 수 있다. 1초 안에 끝나고 DB가 필요 없다. 편집 도중이라 컴파일되지 않으면 조용히 넘어간다(typecheck와 CI가 잡는다) |
| Stop | `stop-check.sh` | HEAD 이후 바뀐 쪽의 정적 검사(서버 typecheck·lint, 클라이언트 lint — CI와 같은 기준)를 돌리고, 실패하면 마지막 30줄을 돌려주고 exit 2. `stop_hook_active`가 true면 바로 통과한다(무한 루프 방지) |

**한계.** PostToolUse 훅은 편집이 일어난 뒤에 알린다. 막지 않고 고치게 한다. 텍스트 패턴이라 `req.user`나
`deletedAt: null` 같은 의미 규칙은 잡지 못한다. 훅 스크립트는 `jq`가 필요하다.

**서버 테스트 스위트는 Stop 훅에서 돌리지 않는다.** 실제 Postgres가 필요하고 한 번에 약 90초 걸린다. DB가 없는
환경에서는 매번 실패해 Claude를 붙잡는다. 파일 단위 테스트는 Claude가 `npx vitest run`으로 돌리고, 전체는 CI가 돌린다.

## 5. 스킬 — `.claude/skills/<name>/SKILL.md`

| 스킬 | 왜 있는가 |
|---|---|
| `run-workbridge` | 로컬 Postgres, `.env` 두 개, 마이그레이션, 시드, dev 서버 두 개를 띄우는 절차가 길다. 로컬 로그인이 모두 루프백 한 주소로 세어져 로그인 제한에 걸리고, Supabase는 `localhost` 스텁이 필요하다. 화면 하나는 `npx playwright cli`로 직접 조작한다 |
| `add-endpoint` | 확장 라우트 하나에 손댈 곳이 열 군데다. 동작 → zod → 서비스 → 얇은 컨트롤러 → 가드 → OpenAPI 등록 → `PROTECTED_ROUTES`·`guardedMutations` → 테스트 → 문서 |
| `db-migration` | 스키마 변경 뒤에 빠뜨리기 쉬운 후속 작업이 많다(손으로 붙이는 RLS·CHECK SQL, `TABLES`, `seed.js`, 응답에 나가는 필드면 OpenAPI 응답 스키마) |
| `pre-pr-review` | `/code-review`와 `REVIEW.md` 번호 항목으로 diff를 보고, 국소적인 것만 고치고, 기존 테스트 단언 완화·기존 컨트롤러 개조는 사람에게 넘긴다. `allowed-tools`로 쓸 수 있는 커맨드를 묶었다 |

**한계.** 스킬은 설명이 요청과 맞을 때만 불린다. 스킬 전체를 끝까지 실행하는 자동 테스트는 없다.

## 6. 리뷰 기준 — `REVIEW.md`

로컬 `pre-pr-review`와 CI 리뷰어가 같은 번호 항목을 읽는다. 항목마다 규칙 한 줄, 이 코드베이스에서의 이유(실제로 난
버그면 그 이슈 번호), diff에서 확인하는 방법이 있다. 사람의 PR에도 적용되므로 훅·권한이 막는 것도 항목에 둔다.
항목 번호는 바꾸지 않는다(`REVIEW #n`으로 참조된다).

## 7. GitHub 워크플로 — `.github/workflows/`

하네스와 검사에 해당하는 것만 적는다. 운영 워크플로(마이그레이션, 시드, 작업 크론, 데이터 이전)는 `docs/DEPLOYMENT.md`에 있다.

| 파일 | 왜 있는가 |
|---|---|
| `ci.yml` | 서버 typecheck·lint·`prisma validate`·`openapi.json` 최신 검사·테스트(실제 Postgres 서비스 컨테이너), 클라이언트 lint·빌드. 로컬 Stop 훅이 돌리지 않는 전체 스위트를 여기서 돌린다 |
| `e2e.yml` | Playwright E2E. 클라이언트에 단위 테스트가 없어서 핵심 흐름은 브라우저로만 확인된다 |
| `claude-code-review.yml` | Claude가 `REVIEW.md`·`CLAUDE.md`와 바뀐 경로의 rules를 읽고 diff를 인라인 코멘트로 리뷰한다(`REVIEW.md` 위반에는 `REVIEW #n`). 드래프트는 건너뛰고, 이미 단 지적은 다시 달지 않는다. 승인·변경 요청·코드 수정은 하지 않는다 — 머지 결정은 사람 몫이다 |
| `claude.yml` | `@claude` 멘션에 답하거나 작업을 맡아 **드래프트 PR**을 연다(이미 열린 PR에서는 그 브랜치에 푸시만). 저장소의 `CLAUDE.md`·rules·스킬을 그대로 읽는다. DB가 없어 vitest는 허용하지 않는다(테스트는 PR의 `ci.yml`). 트리거한 사람에게 쓰기 권한이 있어야 돈다 |

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
- **CodeRabbit 같은 외부 리뷰 봇** — CI 리뷰어는 같은 `REVIEW.md`를 읽는 Claude다. 기준이 두 곳으로 갈라지지 않는다.
- **`req.user`, `deletedAt: null`, `notify()`를 검사하는 훅** — 텍스트 패턴으로는 오탐이 많다. rules, `REVIEW.md`, 중앙 매트릭스 테스트가 맡는다.
- **샌드박스 설정** — 목적이 실수 방지라 OS 수준 격리는 넣지 않았다.
- **Playwright MCP** — 화면 확인은 클라이언트의 Playwright에 들어 있는 `npx playwright cli`로 한다. 터미널 툴이라 MCP 툴
  정의와 큰 응답으로 컨텍스트를 채우지 않고, 버전이 리포지토리의 lockfile에 고정되며, `-s=<세션>`으로 병렬 작업이 서로의
  브라우저를 건드리지 않는다. 사용법은 `run-workbridge` 스킬.
