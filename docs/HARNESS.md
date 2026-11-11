# 하네스 구성

이 문서는 Claude Code 하네스에 관한 사실 중 다른 곳에 둘 수 없는 것만 적는다.
지시문, 훅의 동작, 스킬의 절차, 워크플로의 동작은 각 파일이 원본이다.

## 1. 어디에 무엇을 적는가

사실 하나에는 집 하나를 둔다. 집은 그 사실이 설명하는 대상에 가장 가까운 곳이다.
코드 주석, 설정 파일 주석, 문서 순으로 고르고, 다른 곳에서는 그 집을 링크한다.

- `CLAUDE.md`는 모든 세션과 CI의 Claude가 매번 읽는 지도다. 커맨드, 언제 어떤 문서를 읽을지, 컨벤션, 어느 경로를 고치든 사고가 나는 함정만 둔다.
- `.claude/rules/*.md`는 `paths:`에 맞는 파일을 Claude가 읽거나 고칠 때만 컨텍스트에 들어온다.
  그런 파일을 읽기 전에는 rule이 보이지 않는다.
  rule에는 그 경로에서 할 일과 하지 말 일을 명령문으로 쓴다. 명령마다 한 줄 이유와 `docs/` 링크를 단다.
  서버 파일 하나를 고치면 여러 rule이 함께 들어온다. 그래서 같은 규칙은 한 파일에만 둔다.
- `docs/`는 코드 옆에 둘 수 없는 것을 서술한다. 여러 파일에 걸친 "왜", 리포지토리 밖의 운영 지식, 제품 결정과 그 이유가 여기 온다. rules의 명령문은 다시 적지 않고 링크한다.
- `.github/REVIEW.md`는 로컬 `pre-pr-review` 스킬과 CI 리뷰어가 함께 읽는 리뷰 기준이다. 항목 번호는 `REVIEW #n`으로 참조되므로 바꾸지 않는다.
- 스킬(`.claude/skills/`)은 여러 단계를 거치는 절차를 담는다. 언제 쓰는지는 `description`이 말한다.
- 훅과 워크플로가 무엇을 왜 하는지는 그 파일의 머리 주석이 원본이다. 훅 스크립트는 `jq`가 있어야 돈다.
  Stop 훅은 정적 검사만 돌리고 테스트 스위트는 돌리지 않는다. 스위트는 실제 Postgres가 필요하다.
- 상수, 한도, 개수, 목록 같은 코드의 값은 문서에 옮겨 적지 않는다. 상수 이름이나 파일을 가리킨다.
- 도구가 막을 수 있는 규칙은 도구에 둔다.
  코드 패턴 규칙은 텍스트 패턴을 보는 훅이 아니라 ESLint에 둔다.
  ESLint는 AST를 보므로 주석과 문자열에 오탐하지 않는다.
  또 에디터, Stop 훅, CI에서 사람과 Claude에게 똑같이 걸린다.

## 2. 권한 규칙의 이유

목록의 원본은 `.claude/settings.json`의 `permissions`다. JSON이라 주석을 달 수 없어서 묶음별 이유를 여기 적는다.
어떤 상황에서도 정당하지 않은 것은 `deny`에 둔다. 가끔 정당하지만 되돌리기 어려운 것은 `ask`에 두고, 실행할 때마다 사람이 승인한다.
가끔 필요한 것까지 `deny`에 두면 막힌 에이전트가 다른 커맨드로 돌아가려 한다.

| 묶음 | 이유 |
|---|---|
| deny: `.env` 계열 Read | 서버 `.env`에 JWT 비밀키, 외부 서비스 키, DB 접속 문자열이 있다. Read deny는 같은 파일의 Edit/Write와 Bash의 `grep … .env`도 막으므로 `.env`는 사람이 만든다. `.env.example`은 걸리지 않는다. |
| deny: `migrate reset`, `--force-reset`, `--accept-data-loss` | 스키마와 데이터를 통째로 지운다. 스키마는 새 마이그레이션으로만 바꾼다. |
| deny: 강제 push | 공유 브랜치의 히스토리를 덮어쓴다. `main`은 3절의 ruleset도 막고, 이 규칙은 기능 브랜치까지 막는다. |
| deny: `vercel pull`, `vercel env pull` | 운영 비밀값을 로컬 파일로 내려받는다. 그 파일은 `.env` deny 밖에 놓일 수 있다. |
| ask: `dropdb`, `DROP TABLE`·`DATABASE`·`SCHEMA`, `TRUNCATE` | 병렬 작업이 만든 로컬 DB를 정리할 때는 정당하지만, 잘못 겨누면 데이터를 잃는다. 테스트 DB는 테스트 코드의 `resetDb()`가 비운다. |
| ask: `supabase.co`, `supabase.com` | Preview와 Production의 DB와 저장소가 Supabase에 있다. 원격 마이그레이션과 데이터 작업은 워크플로로 하고, 커맨드로 직접 닿을지는 사람이 그때마다 정한다. |
| ask: `gh workflow run` | 수동으로 실행하는 워크플로는 모두 원격 DB나 저장소를 바꾼다. `seed.yml`은 모든 테이블을 비운다. 워크플로의 `confirm` 입력은 에이전트도 넣을 수 있어서 승인을 따로 받는다. |
| ask: `vercel … --prod`, `vercel promote`, `vercel rollback`, `vercel env …` | 운영 배포는 보통 `main` 머지와 Vercel Git 연동으로 한다. 손으로 운영에 배포·승격·롤백하거나 환경변수를 바꿀 때만 승인한다. |
| allow: 검사 커맨드, `npm run openapi`, 읽기 전용 git·gh | 고치고 검사하는 루프가 매번 승인을 묻지 않게 한다. `npm run openapi`는 DB·환경변수·네트워크 없이 `openapi.json` 한 파일만 다시 쓴다. |

- 쓰는 git(commit, push 등), `gh pr create`, `prisma migrate dev`는 allow에 일부러 넣지 않았다. 실행할 때 사람이 승인한다.
- Bash 규칙은 커맨드 텍스트만 본다. `bash -c '…'`처럼 다른 형태로 부르면 걸리지 않는다. 보안 경계가 아니라 흔한 실수를 막는 장치다.
- deny와 ask의 Bash 패턴은 앞뒤가 `*`인 문자열 포함 패턴이다. 그래서 `grep -rn TRUNCATE` 같은 검색도 걸린다. 검색은 Grep 툴로 한다.
- 한 커맨드가 ask와 deny에 함께 걸리면 deny가 이긴다. 예를 들어 `vercel env pull`은 ask의 `*vercel env *`에도 맞지만 거부된다.
- allow는 워크스페이스를 신뢰한 뒤에만 적용된다. deny와 ask는 항상 적용된다.

## 3. `main` 보호

리포지토리 ruleset "main 보호"가 `main`을 지킨다. 이 설정은 GitHub에만 있고 리포지토리 파일에는 없다.

- `main`은 PR로만 바뀐다. 협업자가 한 명이라 필요한 승인 수는 0이다.
- `main`의 삭제와 강제 push를 막는다. 관리자를 포함해 아무도 우회할 수 없다.
- 머지 전에 필수 체크 세 개가 통과해야 한다. `ci.yml`의 `workbridge-server`와 `workbridge-client`, `e2e.yml`의 `playwright (chromium)`이다.
- AI 리뷰는 일부러 필수 체크에 넣지 않았다. 드래프트 PR, 포크에서 온 PR, 워크플로 파일을 바꾼 PR에서는 돌지 않기 때문이다.

## 4. GitHub Actions의 Claude가 보는 하네스

`claude.yml`과 `claude-code-review.yml`은 `anthropics/claude-code-action`으로 Claude를 돌린다. 각 워크플로의 동작은 파일 머리 주석에 있다.

- PR이 바꾼 하네스는 머지한 뒤에 적용된다. 액션은 Claude를 시작하기 전에 `.claude/`와 `CLAUDE.md` 등을 base 브랜치의 내용으로 되돌린다. PR이 CI의 Claude에게 줄 지시를 바꾸지 못하게 하는 장치다.
- 리뷰 기준도 같다. 리뷰 프롬프트가 `git show origin/<base>:…`로 base 브랜치의 리뷰 기준을 읽는다. 그래서 기준을 바꾸는 PR은 바뀌기 전 기준으로 리뷰받는다.
- 액션은 워크플로 파일이 기본 브랜치의 것과 다르면 실행하지 않는다. 그래서 워크플로를 고친 PR에는 AI 리뷰가 돌지 않고, 체크는 통과로 표시된다.
- `claude.yml`에는 `ci.yml` 서버 잡과 같은 Postgres 서비스 컨테이너가 붙어 있다. `@claude`는 서버 테스트를 직접 돌리고, 버그를 고칠 때 회귀 테스트가 고치기 전 코드에서 실패하는지 스스로 확인한다. 리뷰 워크플로(`claude-code-review.yml`)에는 DB가 없다. 리뷰는 코드를 읽기만 하고, 테스트 결과는 PR의 CI가 보여 준다.
- `@claude`가 여는 PR은 드래프트이고, 리뷰 워크플로는 드래프트를 건너뛴다. 사람이 diff를 보고 Ready for review를 누르면 AI 리뷰가 시작된다. 리뷰를 시작하고 머지하는 결정은 사람이 한다.
- CI 리뷰어가 일관되게 보는 것은 `.github/REVIEW.md`와 rules가 다루는 것뿐이다. 리뷰 코멘트는 머지를 막지 않는다.

## 5. MCP

`.mcp.json`은 Sentry MCP 서버를 연결한다. 운영과 프리뷰 서버의 오류를 Sentry 프로젝트 `workbridge-server`에서 조회해 원인을 찾을 때 쓴다. 사용자마다 OAuth 로그인이 필요하다.
