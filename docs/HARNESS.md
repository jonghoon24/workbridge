# 하네스 구성

이 리포지토리는 Claude Code와 Codex CLI 두 에이전트 도구로 작업한다. 하네스 파일은 두 도구가 함께 쓰고,
한 도구만 읽는 형식인 것만 도구별로 둔다.
이 문서는 하네스에 관한 사실 중 다른 곳에 둘 수 없는 것만 적는다.
지시문, 훅의 동작, 스킬의 절차, 워크플로의 동작은 각 파일이 원본이다.

## 1. 어디에 무엇을 적는가

사실 하나에는 집 하나를 둔다. 집은 그 사실이 설명하는 대상에 가장 가까운 곳이다.
코드 주석, 설정 파일 주석, 문서 순으로 고르고, 다른 곳에서는 그 집을 링크한다.

- `AGENTS.md`는 모든 세션과 CI의 에이전트가 매번 읽는 지도다. 커맨드, 언제 어떤 문서를 읽을지, 컨벤션, 경로와 상관없이 걸리는 함정만 둔다.
  `CLAUDE.md`는 Claude Code가 `AGENTS.md`를 읽게 하는 import(`@AGENTS.md`)다. Claude Code에만 해당하는 지시만 여기에 더한다.
- `.claude/rules/*.md`는 경로별 규칙이다. Claude Code에서는 `paths:`에 맞는 파일을 읽거나 고칠 때만 컨텍스트에 들어온다.
  그런 파일을 읽기 전에는 rule이 보이지 않는다. Codex에는 같은 기능이 없어서 `AGENTS.md` "경로별 규칙" 표를 보고
  에이전트가 직접 읽는다. rule을 더하거나 `paths:`를 바꾸면 그 표도 고친다.
  rule에는 그 경로에서 할 일과 하지 말 일을 명령문으로 쓴다. 명령마다 한 줄 이유와 `docs/` 링크를 단다.
  서버 파일 하나를 고치면 여러 rule이 함께 들어온다. 그래서 같은 규칙은 한 파일에만 둔다.
- `docs/`는 코드 옆에 둘 수 없는 것을 서술한다. 여러 파일에 걸친 "왜", 리포지토리 밖의 운영 지식, 제품 결정과 그 이유가 여기 온다. rules의 명령문은 다시 적지 않고 링크한다.
- `.github/REVIEW.md`는 로컬 `pre-pr-review` 스킬, CI 리뷰어, 사람 리뷰어가 함께 읽는 리뷰 기준이다. 항목 번호는 `REVIEW #n`으로 참조되므로 바꾸지 않는다.
- 스킬(`.claude/skills/`)은 여러 단계를 거치는 절차를 담는다. 언제 쓰는지는 `description`이 말한다. 본문은 두 도구에서
  모두 따를 수 있게 쓰고, 도구마다 방법이 다른 단계만 나눠 적는다.
- 훅과 워크플로가 무엇을 왜 하는지는 그 파일의 머리 주석이 원본이다. 훅 스크립트는 `jq`가 있어야 돈다.
  Stop 훅은 정적 검사만 돌리고 테스트 스위트는 돌리지 않는다. 스위트는 실제 Postgres가 필요하다.
- 상수, 한도, 개수, 목록 같은 코드의 값은 문서에 옮겨 적지 않는다. 상수 이름이나 파일을 가리킨다.
- 도구가 막을 수 있는 규칙은 도구에 둔다.
  코드 패턴 규칙은 텍스트 패턴을 보는 훅이 아니라 ESLint에 둔다.
  ESLint는 AST를 보므로 주석과 문자열에 오탐하지 않는다.
  또 에디터, Stop 훅, CI에서 사람과 에이전트에게 똑같이 걸린다.

## 2. 도구별 위치

| 종류 | 원본 | Claude Code가 읽는 곳 | Codex가 읽는 곳 |
|---|---|---|---|
| 지시문 | `AGENTS.md` | `CLAUDE.md`의 `@AGENTS.md` | `AGENTS.md` |
| 경로별 규칙 | `.claude/rules/*.md` | 같은 파일(`paths:`로 자동) | `AGENTS.md` "경로별 규칙" 표를 보고 직접 |
| 스킬 | `.claude/skills/` | 같은 폴더 | `.agents/skills`(`.claude/skills`를 가리키는 링크) |
| 훅 | `.claude/hooks/*.sh` | `.claude/settings.json`의 `hooks` | `.codex/hooks.json` |
| 권한 | 도구별 | `.claude/settings.json`의 `permissions` | `.codex/config.toml`의 권한 프로필(파일), `.codex/rules/workbridge.rules`(커맨드) |
| MCP | 도구별 | `.mcp.json` | `.codex/config.toml`의 `mcp_servers` |

- `CLAUDE.md`를 지우고 Claude Code가 `AGENTS.md`를 직접 읽게 두지 않는다. 그 방식은 `CLAUDE.md`나 `CLAUDE.local.md`가
  하나라도 있으면 꺼지므로, `CLAUDE.local.md`를 둔 개발자에게서 팀 지시문이 빠진다.
- 스킬과 훅의 실제 파일은 `.claude/` 아래 둔다. Codex 샌드박스는 `.agents/`와 `.codex/`를 읽기 전용으로 보호해서,
  원본이 거기 있으면 Codex가 스킬을 고칠 때마다 승인을 묻는다. 링크는 git이 심볼릭 링크로 저장하므로 Windows
  체크아웃에는 `core.symlinks`가 필요하다.
- 스킬 프런트매터의 `allowed-tools`, `argument-hint`는 Claude Code만 쓴다. Codex는 무시한다.
- 훅 스크립트 하나가 두 도구의 입력을 함께 읽는다(입력 모양은 `protect-migrations.sh` 머리 주석). 두 도구 모두 셸로
  쓴 파일(`sed -i`, 리다이렉트)은 편집 훅에 걸리지 않는다. 커밋된 마이그레이션은 CI가 최종으로 막는다.

## 3. Codex 처음 설정

클론마다 한 번 한다.

1. 리포지토리 루트에서 `codex`를 띄우고 "Trust this folder?"에서 "Trust and continue"를 고른다.
2. 이어서 뜨는 "Hooks need review"에서 훅 세 개를 검토하고 신뢰한다(나중에는 `/hooks`).
3. `codex mcp login sentry`로 Sentry에 로그인한다.

- `.codex/`(설정, 권한 프로필, 규칙, 훅, MCP)는 신뢰한 프로젝트에서만 로드된다. 신뢰하지 않으면 통째로 빠지고
  `codex exec`는 "Untrusted project-local configuration is disabled" 경고만 낸다. `AGENTS.md`와 스킬은 신뢰와 상관없이 읽힌다.
- 훅 신뢰는 클론 경로와 훅 정의의 해시로 `~/.codex/config.toml`에 기록된다. `.codex/hooks.json`이 바뀌면 다시 신뢰한다.
  TUI는 신뢰하지 않은 훅을 알려 주지만 `codex exec`는 경고 없이 건너뛴다.
- `git worktree`로 만든 작업 폴더에서는 Codex가 훅 정의를 그 폴더가 아니라 메인 체크아웃의 `.codex/hooks.json`에서
  읽는다. 메인 체크아웃이 이 파일이 없는 브랜치에 있으면 worktree에서도 훅이 돌지 않는다. 훅이 부르는 스크립트는
  worktree의 것이다.
- 개인 `~/.codex/config.toml`이나 고른 프로필에 `sandbox_mode`가 있거나 `--sandbox`/`-s`로 띄우면 권한 프로필이
  꺼져 `.env`가 읽힌다. `sandbox_mode`는 두지 않는다.
- 권한 프로필이 `.env` 읽기를 막는 동안에는 에이전트 커맨드의 네트워크가 열리지 않는다. allow 규칙에 맞는 커맨드도
  `.env` 차단과 네트워크 차단을 그대로 받고, 권한 상승을 승인한 커맨드는 `.git`에 쓸 수 있지만 네트워크는 막혀 있다. 그래서
  에이전트는 typecheck와 lint는 돌리지만 localhost Postgres나 네트워크가 필요한 커맨드(서버 테스트, `test-db.sh`,
  `prisma migrate dev`, E2E, `git fetch`·`push`, `gh`)는 승인해도 돌리지 못한다. 이런 커맨드는 개발자가 TUI에서
  `!`를 앞에 붙여 직접 돌리거나(네트워크 제한 없이 돌고 결과가 대화에 남는다) 터미널에서 돌린다.
  `npm run openapi`도 샌드박스 안에서는 실패하지만 PostToolUse 훅이 샌드박스 밖에서 다시 만든다.
  Codex CLI 0.170에서 확인한 동작이다. 버전을 올려 달라지면 이 항목과 4절 표의 allow 행을 고친다.

## 4. 권한 규칙의 이유

목록의 원본은 Claude Code는 `.claude/settings.json`의 `permissions`, Codex는 `.codex/config.toml`의 권한 프로필과
`.codex/rules/workbridge.rules`다. JSON에는 주석을 달 수 없어서 묶음별 이유를 여기 적는다.
어떤 상황에서도 필요 없는 것은 `deny`(Codex `forbidden`)에 둔다. 가끔 필요하지만 되돌리기 어려운 것은 `ask`(Codex `prompt`)에
두고, 실행할 때마다 사람이 승인한다. 가끔 필요한 것까지 `deny`에 두면 막힌 에이전트가 다른 커맨드로 돌아가려 한다.

| 묶음 | 이유 | Codex에서 |
|---|---|---|
| deny: `.env` 계열 Read | 서버 `.env`에 JWT 비밀키, 외부 서비스 키, DB 접속 문자열이 있다. Read deny는 같은 파일의 Edit/Write와 Bash의 `grep … .env`도 막으므로 `.env`는 사람이 만든다. `.env.example`은 걸리지 않는다. | 권한 프로필의 같은 글롭이 에이전트가 돌리는 모든 프로세스와 파일 편집을 막는다. `cat`이든 `dotenv`든 읽지 못하고, 그 대신 에이전트 커맨드의 네트워크도 열리지 않는다(3절). |
| deny: `migrate reset`, `--force-reset`, `--accept-data-loss` | 스키마와 데이터를 통째로 지운다. 스키마는 새 마이그레이션으로만 바꾼다. | `forbidden`. `prisma migrate reset`과 `npx` 형태, `db push` 바로 뒤에 온 두 플래그만 잡는다. |
| deny: 강제 push | 공유 브랜치의 히스토리를 덮어쓴다. `main`은 5절의 ruleset도 막고, 이 규칙은 기능 브랜치까지 막는다. | `forbidden`. `git push`나 `git push origin` 바로 뒤의 `-f`·`--force`·`--force-with-lease`만 잡는다. push는 네트워크가 막혀 에이전트가 돌리지 못한다(3절). |
| deny: `vercel pull`, `vercel env pull` | 프로덕션 비밀값을 로컬 파일로 내려받는다. 그 파일은 `.env` deny 밖에 놓일 수 있다. | `forbidden`. `vercel`과 `npx vercel` 형태. |
| ask: `dropdb`, `DROP TABLE`·`DATABASE`·`SCHEMA`, `TRUNCATE` | 병렬 작업이 만든 로컬 DB를 정리할 때는 필요하지만, 잘못 겨누면 데이터를 잃는다. 테스트 DB는 테스트 코드의 `resetDb()`가 비운다. | `dropdb`만 `prompt`. SQL 문은 인자 안에 있어 규칙으로 못 잡는다. 샌드박스가 localhost를 막아 `psql`과 `dropdb`가 로컬 DB에 닿지 못한다. |
| ask: `supabase.co`, `supabase.com` | Preview와 Production의 DB와 저장소가 Supabase에 있다. 원격 마이그레이션과 데이터 작업은 워크플로로 하고, 커맨드로 직접 접속할지는 사람이 그때마다 정한다. | 규칙 없음. 샌드박스가 네트워크를 막아 원격 접속이 되지 않는다. |
| ask: `gh workflow run` | 수동으로 실행하는 워크플로는 모두 원격 DB나 저장소를 바꾼다. `seed.yml`은 모든 테이블을 비운다. 워크플로의 `confirm` 입력은 에이전트도 넣을 수 있어서 승인을 따로 받는다. | `prompt`. |
| ask: `vercel … --prod`, `vercel promote`, `vercel rollback`, `vercel env …` | 프로덕션 배포는 보통 `main` 머지와 Vercel Git 연동으로 한다. 손으로 프로덕션에 배포·승격·롤백하거나 환경변수를 바꿀 때만 승인한다. | `vercel`과 `npx vercel` 전체를 `prompt`. 플래그 위치가 정해져 있지 않아서다. |
| allow: 검사 커맨드, `npm run openapi`, 읽기 전용 git·gh | 고치고 검사하는 루프가 매번 승인을 묻지 않게 한다. `npm run openapi`는 DB·환경변수·네트워크 없이 `openapi.json` 한 파일만 다시 쓴다. | 규칙 없음. typecheck, lint, 읽는 git은 샌드박스 안에서 묻지 않고 돈다. 테스트, E2E, `gh`는 allow 규칙으로도 샌드박스를 벗어나지 못해서(3절) 규칙을 두지 않는다. |

- 쓰는 git(commit, push 등), `gh pr create`, `prisma migrate dev`는 allow에 일부러 넣지 않았다. 실행할 때 사람이 승인한다.
  Codex에서는 `git commit`이 `.git` 쓰기 승인을 거치고, 네트워크나 localhost가 필요한 나머지는 개발자가 돌린다(3절).
- 두 도구의 커맨드 규칙은 커맨드 텍스트만 본다. `bash -c '…'`처럼 셸을 한 번 더 감싸 부르면 Claude Code의 Bash 규칙도,
  Codex의 `forbidden`도 걸리지 않는다. 보안 경계가 아니라 흔한 실수를 막는 장치다.
- Claude Code의 deny와 ask의 Bash 패턴은 앞뒤가 `*`인 문자열 포함 패턴이다. 그래서 `grep -rn TRUNCATE` 같은 검색도 걸린다. 검색은 Grep 툴로 한다.
- Codex의 규칙은 문자열 포함이 아니라 argv 앞부분을 비교한다. 위 표에서 "만 잡는다"고 적은 나머지 형태는 샌드박스의
  네트워크·localhost 차단에 맡긴다. Codex 훅은 `ask`를 표현하지 못해서 문자열 패턴을 흉내 내는 Bash 훅은 두지 않는다.
- 한 커맨드가 ask와 deny에 함께 걸리면 deny가 이긴다(Codex도 `forbidden` > `prompt`). 예를 들어 `vercel env pull`은 ask의 `*vercel env *`에도 맞지만 거부된다.
- Claude Code의 allow는 워크스페이스를 신뢰한 뒤에만 적용되고 deny와 ask는 항상 적용된다. Codex는 `forbidden`까지
  포함한 프로젝트 규칙 전체가 신뢰한 뒤에만 적용된다.
- 개인 설정의 `approvals_reviewer`가 `auto_review`이면 Codex의 `prompt`와 권한 상승 요청을 사람 대신 검토 모델이 승인한다.
- 규칙을 고치면 `codex execpolicy check --rules .codex/rules/workbridge.rules -- <커맨드>`로 확인한다. 각 규칙의
  `match`·`not_match` 예시는 Codex가 규칙을 읽을 때 검사한다.

## 5. `main` 보호

리포지토리 ruleset "main 보호"가 `main`을 지킨다. 이 설정은 GitHub에만 있고 리포지토리 파일에는 없다.

- `main`은 PR로만 바뀐다. 협업자가 한 명이라 필요한 승인 수는 0이다.
- `main`의 삭제와 강제 push를 막는다. 관리자를 포함해 아무도 우회할 수 없다.
- 머지 전에 필수 체크 세 개가 통과해야 한다. `ci.yml`의 `workbridge-server`와 `workbridge-client`, `e2e.yml`의 `playwright (chromium)`이다.
- AI 리뷰는 일부러 필수 체크에 넣지 않았다. 드래프트 PR, 포크에서 온 PR, 워크플로 파일을 바꾼 PR에서는 돌지 않기 때문이다.

## 6. GitHub에서 도는 에이전트가 보는 하네스

`claude.yml`과 `claude-code-review.yml`은 `anthropics/claude-code-action`으로 Claude Code를 돌린다. 각 워크플로의 동작은
파일 머리 주석에 있다. 액션 안의 Claude Code도 로컬과 같이 `CLAUDE.md`의 import로 `AGENTS.md`를 읽고, 읽거나 고치는 파일에 맞는 rules를 불러온다.

- Claude 워크플로에서는 PR이 바꾼 하네스가 머지한 뒤에 적용된다. 액션은 Claude Code를 시작하기 전에 `.claude/`, `CLAUDE.md`, `AGENTS.md` 등을
  base 브랜치의 내용으로 되돌린다. PR이 CI의 Claude에게 줄 지시를 바꾸지 못하게 하는 장치다.
- 리뷰 기준도 같다. 리뷰 프롬프트가 `git show origin/<base>:…`로 base 브랜치의 리뷰 기준을 읽는다. 그래서 기준을 바꾸는 PR은 바뀌기 전 기준으로 리뷰받는다.
- 액션은 워크플로 파일이 기본 브랜치의 것과 다르면 실행하지 않는다. 그래서 워크플로를 고친 PR에는 AI 리뷰가 돌지 않고, 체크는 통과로 표시된다.
- CI 리뷰어가 일관되게 보는 것은 `.github/REVIEW.md`와 rules가 다루는 것뿐이다. 리뷰 코멘트는 머지를 막지 않는다.
- Codex 코드 리뷰는 ChatGPT Codex Connector GitHub 앱이 돌린다. 설정은 ChatGPT의 Codex 코드 리뷰 설정에 있고, 리포지토리에는
  워크플로도 시크릿도 없다. 자동 리뷰는 `main`으로 가는 PR에서 돈다. 다른 브랜치로 가는 PR은 `@codex review` 코멘트로 부른다.
- Codex 리뷰 규칙의 원본은 `AGENTS.md`의 `## Code Review Rules` 절이다. 이 절이 `.github/REVIEW.md`와 경로별 rules를
  가리키므로 두 리뷰어가 같은 기준을 쓴다. 리뷰 기준을 바꿀 때는 `.github/REVIEW.md`를 고치고 이 절은 그대로 둔다.
  Codex는 GitHub에 P0·P1 지적만 달기 때문에 이 절이 항목 위반을 P1로 다루게 한다.
- Codex 리뷰는 base가 아니라 PR의 `AGENTS.md`를 읽는다. 그래서 리뷰 규칙을 바꾸는 PR은 바뀐 규칙으로 리뷰받는다
  (Claude 리뷰는 base의 것을 쓴다). `AGENTS.md`의 이 절이나 `.github/REVIEW.md`를 고치는 PR은 사람이 그 변경을 직접 본다.
- Codex 리뷰는 GitHub 체크로 나타나지 않고 머지를 막지 않는다.

## 7. MCP

Sentry MCP 서버를 연결한다. Claude Code는 `.mcp.json`, Codex는 `.codex/config.toml`이 같은 서버를 가리킨다.
프로덕션과 프리뷰 서버의 오류를 Sentry 프로젝트 `workbridge-server`에서 조회해 원인을 찾을 때 쓴다.
사용자마다 OAuth 로그인이 필요하다(Claude Code는 `/mcp`, Codex는 `codex mcp login sentry`).

## 8. 팀이 공유하는 것 / 내 컴퓨터에만 두는 것

| | Claude Code | Codex |
|---|---|---|
| 팀이 공유(커밋) | `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/{rules,hooks,skills}/`, `.mcp.json` | `AGENTS.md`, `.codex/config.toml`, `.codex/rules/`, `.codex/hooks.json`, `.agents/skills` |
| 내 컴퓨터에만 | `.claude/settings.local.json`, `CLAUDE.local.md`, `~/.claude/` | `~/.codex/config.toml`, `~/.codex/AGENTS.md`, `~/.codex/rules/` |

- `.gitignore`는 `.claude/`, `.codex/`, `.agents/`에서 위 공유 파일만 추적하고, `CLAUDE.local.md`와 `AGENTS.override.md`를 무시한다.
- Codex에는 프로젝트별 개인 파일이 없다. `AGENTS.override.md`는 같은 폴더의 `AGENTS.md`에 덧붙지 않고 그 파일을
  대신하므로 쓰지 않는다. 개인 지시는 `~/.codex/AGENTS.md`, 개인 설정은 `~/.codex/config.toml`에 둔다.
- Codex TUI에서 "다시 묻지 않기"를 고르면 그 커맨드가 `~/.codex/rules/default.rules`에 기록된다. 팀이 함께 쓸 규칙이면
  `.codex/rules/workbridge.rules`로 옮긴다.
