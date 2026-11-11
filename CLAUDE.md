# CLAUDE.md

WorkBridge(프리랜서 매칭 플랫폼)는 의뢰인(`CLIENT`)과 프리랜서(`FREELANCER`)를 잇는다. 프로젝트 탐색
→ 지원 → 계약 → 마일스톤 결제(토스페이먼츠) → 정산 → 상호 리뷰가 기본 흐름이고, 메시지, 포트폴리오,
AI 단가 분석(OpenAI)이 붙어 있다.

npm 패키지 두 개가 따로 있다(워크스페이스 툴 없음 — 커맨드는 각 패키지 안에서 실행한다).
- `workbridge-server/` — Express + Prisma + PostgreSQL API, **TypeScript**, Vercel 배포.
- `workbridge-client/` — Next.js 14 App Router, **JSX(TS 아님)**, Tailwind, Zustand.

## 커맨드

서버(`workbridge-server/`):
```bash
npm run dev                          # tsx watch, http://localhost:4000
npm run typecheck                    # src/와 test/에 tsc --noEmit
npm run lint                         # typescript-eslint. 기존 `any`는 eslint-suppressions.json에 기록
bash scripts/test-db.sh              # 로컬 workbridge_test 생성 + 마이그레이션 (URL 출력)
npm test                             # 그 실제 Postgres로 vitest (~90초). 모든 테이블을 TRUNCATE
npx vitest run test/<file>.test.ts   # 파일 하나
npx prisma migrate dev --name <name> # 새 마이그레이션 생성·적용, 클라이언트 재생성
npm run db:generate                  # 마이그레이션을 migrate deploy로만 받았을 때 클라이언트 재생성
npm run db:seed                      # 시드 데이터 (docs/SEED_DATA.md)
npm run openapi                      # openapi.json 재생성. 커밋한다(CI가 최신인지 검사)
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
| 엔드포인트, 요청·응답, 상태 코드와 오류 메시지 | `GET /api/docs`(로컬 서버) / `workbridge-server/openapi.json` |
| 제품 결정과 그 이유, 용어, 상태 전이 / DB 불변식, 잠금, FK 삭제 동작 | `docs/domain/` / `docs/DATABASE.md` |
| 환경변수 / 배포와 운영 환경의 한계 | `docs/ENV.md` / `docs/DEPLOYMENT.md` |
| 시드 계정과 화면별 시나리오 | `docs/SEED_DATA.md` |
| 이 하네스(지침, 권한, 훅, 스킬) / 리뷰 기준 | `docs/HARNESS.md` / `REVIEW.md` |

## 구조 요약

- 서버: `src/index.ts`가 `/api/*` 라우터를 마운트하고 `export default app`(Vercel). 기존 도메인은
  `routes → controllers → lib`, 확장 도메인은 `src/services/`를 더 쓴다(`docs/ARCHITECTURE.md`).
- 데이터: `User → Project → Application → Contract → Milestone/Payment → Review`.
  `User`와 `Project`는 소프트 삭제(`deletedAt`) — 어디서나 `deletedAt: null`로 거른다.

## 테스트

- 실패한 테스트를 통과시키려고 단언을 지우거나 약하게 바꾸지 않는다. 동작을 바꾸는 것이 요청받은 변경일 때만 테스트를 고친다.
- 기존 코드에 테스트를 붙이다가 버그로 보이는 동작을 만나면 그 동작을 단언으로 고정하지 않고 보고한다.
- 버그를 고치는 PR에는 고치기 전 코드에서 실패하는 회귀 테스트를 넣는다.

## 컨벤션

- 언어: 문서·커밋·PR·이슈·리뷰 코멘트와 작업 보고는 한국어(PR·코멘트·보고는 합니다체), 코드·식별자·테스트 이름은 영어.
- 커밋: `type(scope): 한국어 서술` — type은 `feat|fix|docs|test|refactor|style|chore|ci`, scope는 `server|client|harness|deploy`(생략 가능).

## 함정 (바로 사고가 나는 것)

- 프로젝트를 읽는 GET 중 일부는 **행을 쓴다.** `workbridge-server/src/lib/projectLifecycle.ts`의 지연 수명주기 스윕
  (`closeExpiredOpenProjects`, `rejectPendingApplicationsForClosedProjects`)이 마감된 프로젝트를 닫고 그 대기 중
  지원을 거절한다. 어느 핸들러인지는 두 함수의 호출처로 확인한다. 읽기 전용으로 다루지 않는다 — 캐시, 빌드 때의
  정적 렌더링, 원격 환경에 대한 "확인용" 호출도 그 환경의 행을 바꾼다.
- 운영에는 상주 작업 워커가 없다. GitHub Actions `jobs.yml`이 15분마다 `POST /api/internal/jobs/run`을
  부르므로 작업은 최대 15분 늦게 돈다. 지급(`JOB_PAYOUT_ENABLED`)과 메일(`JOB_EMAIL_ENABLED`) 작업은 플래그로 꺼져 있다.
