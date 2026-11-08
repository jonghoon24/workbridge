# CLAUDE.md

WorkBridge(프리랜서 매칭 플랫폼)는 의뢰인(`CLIENT`)과 프리랜서(`FREELANCER`)를 잇는다. 프로젝트 탐색
→ 지원 → 계약 → 마일스톤 결제(토스페이먼츠) → 정산 → 상호 리뷰가 기본 흐름이고, 메시지, 포트폴리오,
AI 단가 분석(OpenAI `gpt-4o-mini`)이 붙어 있다.

npm 패키지 두 개가 따로 있다(워크스페이스 툴 없음 — 커맨드는 각 패키지 안에서 실행한다).
- `workbridge-server/` — Express + Prisma + PostgreSQL API, **TypeScript**, Vercel 배포.
- `workbridge-client/` — Next.js 14 App Router, **JSX(TS 아님)**, Tailwind, Zustand.

## 커맨드

서버(`workbridge-server/`):
```bash
npm run dev                          # tsx watch, http://localhost:4000
npm run typecheck                    # src/와 test/에 tsc --noEmit
bash scripts/test-db.sh              # 로컬 workbridge_test 생성 + 마이그레이션 (URL 출력)
npm test                             # 그 실제 Postgres로 vitest (~90초). 모든 테이블을 TRUNCATE
npx vitest run test/<file>.test.ts   # 파일 하나
npx prisma migrate dev --name <name> # 새 마이그레이션. 그다음 npm run db:generate
npm run db:seed                      # 시드 데이터 (docs/SEED_DATA.md)
```

클라이언트(`workbridge-client/`):
```bash
npm run dev     # http://localhost:3000 (/api/*를 :4000으로 전달)
npm run lint    # next lint
npm run build   # 클라이언트의 정합성 검사 — 단위 테스트가 없다
```
E2E는 리포지토리 루트에서 `bash scripts/e2e.sh`(Playwright, `workbridge-client/e2e/`).
앱 전체를 띄우고 확인할 때는 `run-workbridge` 스킬을 쓴다.

## 어디를 읽을지

| 필요할 때 | 문서 |
|---|---|
| 레이어, 요청 흐름, 작업 큐, 클라이언트 구조, 환경 | `docs/ARCHITECTURE.md` |
| API가 **어떻게 동작해야 하는지** | `docs/BEHAVIOR.md` (영문) |
| 엔드포인트 목록 / DB 모델과 불변식 | `docs/API.md` / `docs/DATABASE.md` |
| 환경변수 / 배포와 운영 환경의 한계 | `docs/ENV.md` / `docs/DEPLOYMENT.md` |
| 시드 계정과 화면별 시나리오 | `docs/SEED_DATA.md` |
| 이 하네스(지침, 권한, 훅, 스킬) / 리뷰 기준 | `docs/HARNESS.md` / `REVIEW.md` |

**`docs/BEHAVIOR.md`가 명세이자 테스트 오라클이다.** 코드가 명세와 다른 곳은 "Known divergences"에
불일치 번호(D3, D5, …)로 올라 있고 `it.fails`로 고정돼 있다. 지금 동작이 곧 명세는 아니다.

경로별 상세 지침은 `.claude/rules/`에 있고, 해당 경로의 파일을 다룰 때 자동으로 컨텍스트에 들어온다.

## 구조 요약

- 서버: `src/index.ts`가 `/api/*` 라우터를 마운트하고 `export default app`(Vercel). 기존 도메인은
  `routes → controllers → lib`, 확장 도메인은 `services/`와 zod `schemas/`를 더 쓴다. 혼재는 의도된 것이다.
- 에러는 `throw new AppError(message, status)` → `next(err)` → `errorHandler`가 `{ error: { message } }`.
- 데이터: `User → Project → Application → Contract → Milestone/Payment → Review`.
  `User`와 `Project`는 소프트 삭제(`deletedAt`) — 어디서나 `deletedAt: null`로 거른다.
- 클라이언트: 백엔드 호출은 모두 `src/lib/api.js`(Axios + 조용한 토큰 갱신)를 거친다.

## 컨벤션

- 언어: 문서·커밋·PR·이슈·리뷰 코멘트와 작업 보고는 한국어(PR·코멘트·보고는 합니다체), 코드·식별자·테스트 이름은 영어.
- 커밋: `type(scope): 한국어 서술` — type은 `feat|fix|docs|test|refactor|style|chore|ci`, scope는 `server|client|harness|deploy`(생략 가능).

## 함정 (바로 사고가 나는 것)

- `src/index.ts`에서 `import 'dotenv/config'`는 **반드시 첫 import**로 둔다. 모듈 평가 때
  `process.env`를 읽는 모듈이 여럿 있다.
- 라우터 마운트 순서가 동작을 정한다. `/api/users`는 `users.routes` 다음 `profile.routes`,
  `/api/projects`는 `projects.routes` 다음 `applications.routes`. 먼저 마운트된 쪽이 이긴다.
  새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣고, 순서는 절대 바꾸지 않는다.
- `GET /api/projects`와 `GET /api/projects/:id`는 **행을 쓴다**(지연 수명주기 스윕이 마감된
  프로젝트를 닫는다). 읽기 전용이 아니다.
- `req.user`는 non-optional로 타입이 잡혀 있지만 `src/types/index.ts`에 적힌 공개 핸들러 12개에서는
  `undefined`다(`X-Internal-Token`으로 지키는 `runJobs` 포함). 거기서는 읽지 않는다.
- 핸들러에 `Promise<void>`를 붙이지 않는다. 함수 중간에 `return res.json(...)`하는 곳이 많다.
- 여러 행을 바꾸는 상태 변경은 `prisma.$transaction` 하나로 하고, 알림과 작업도 그 안에서 쓴다.
- 적용된 마이그레이션은 고치지 않는다(훅이 막는다). 스키마를 바꾸고 `prisma migrate dev`.
- `console.*` 대신 `lib/logger.ts`를 쓴다. `error` 레벨은 500과 작업 실패에만 쓴다.
- 이메일은 로그로만 남는다(`mail.sent` 줄). 결제 우회 플래그는 운영에서 반드시 `false`.
- 운영에는 작업 워커가 없다. 자동 승인, 정산, 이메일은 `POST /api/internal/jobs/run` /
  `npm run jobs:run`으로만 돈다.
