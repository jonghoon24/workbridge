# 구조

WorkBridge의 코드가 어떻게 짜여 있는지 설명한다. 제품 규칙은 [domain/](domain/README.md), API 계약은 OpenAPI 문서
(아래 "API 계약: OpenAPI")가 기준이고, 파일을 고칠 때 지킬 것은 `.claude/rules/`에 경로별로 있다. 이 문서는 "어디에 무엇이 있고 왜 그렇게 나뉘었는지"만 다룬다.
패키지는 `workbridge-server/`(Express + Prisma, TypeScript, 진입점 `src/index.ts`)와 `workbridge-client/`
(Next.js 14 App Router, JSX) 둘이다. 브라우저는 클라이언트의 같은 출처 `/api/*`만 부르고, Next 라우트
핸들러가 서버로 전달한다.

## 서버 요청 흐름

`src/index.ts`가 미들웨어와 라우터를 이 순서로 건다.

1. `requestId` → `accessLog`(`src/middlewares/`): 모든 응답에 `X-Request-Id`와 접근 로그 한 줄.
2. `cors`(`CLIENT_URL`, `CORS_ORIGINS`) → `express.json()` → `cookieParser()` → `bindRequestContext`.
3. 도메인 라우터(`src/routes/*.routes.ts`). `/api/users`는 users → profile, `/api/projects`는 projects → applications 순이고,
   경로가 겹치면 먼저 마운트된 쪽이 이긴다.
4. 마지막에 `errorHandler`(`src/middlewares/errorHandler.ts`).

### 레이어: 기존 도메인과 확장 도메인

| | 기존 도메인 | 확장 도메인 |
| --- | --- | --- |
| 도메인 | auth, users, projects, applications, contracts, payments, reviews, notifications | milestones, settlements, payout account, contract list, conversations, portfolio/careers, recommendations, notification preferences |
| 흐름 | `routes → controllers → lib` | `routes → controllers → services → lib` |
| 로직 | 컨트롤러 안 | `src/services/*.service.ts`, 일부는 `src/lib/`(추천은 `lib/recommendations.ts`) |
| 소프트 삭제된 호출자 | 다시 확인하지 않는다([#7](https://github.com/jonghoon24/workbridge/issues/7)) | `requireActiveUser`(`src/middlewares/activeUser.ts`)가 401 |

요청 검증은 양쪽 모두 zod 스키마(`src/schemas/`)와 `validate()`(`src/middlewares/validate.ts`)가 맡는다(400
`<path>: <문장>`). 확장 라우트가 기존 라우터 파일에 들어간 곳도 있다(지급 계좌 `users.routes.ts`, 계약 목록 `contracts.routes.ts`,
추천 프리랜서 `projects.routes.ts`). 혼재는 의도된 것이다. 기존 컨트롤러를 서비스 레이어로 옮기는 일은 버그 수정이나
기능 변경에 섞지 않고 도메인 단위로 따로 한다. 계획과 순서는 [#40](https://github.com/jonghoon24/workbridge/issues/40)에 있다.

### 인증과 권한

- `authenticate`(`src/middlewares/auth.ts`): `Authorization: Bearer <access token>`을 검증해 `req.user`를 채운다(실패 401).
- 확장 라우트의 체인: `authenticate → requireActiveUser → requireRole(...) → [업로드] → validate → controller`.
  가드는 라우트마다 붙이고 `router.use`는 쓰지 않는다.
- 기존 라우트는 `authenticate → requireRole(...) → validate`(입력이 있을 때) 뒤에 컨트롤러가 소유권을 직접
  확인한다. 프로젝트 등록은 `requireCompleteProfile`(`src/middlewares/profile.ts`)도 거친다.
- 로그인과 AI 분석에는 `rateLimit`(`src/middlewares/rateLimit.ts`, 카운터는 `RateLimitCounter` 테이블)이 붙는다.
  `POST /api/internal/jobs/run`은 JWT 대신 `requireInternalToken`(`X-Internal-Token`)으로 지킨다.
- 공개 핸들러 15개에서는 `req.user`가 `undefined`다. 목록은 `src/types/index.ts`에 있다.

**에러 처리.** 컨트롤러와 서비스는 `throw new AppError(message, status)`(`src/lib/errors.ts`)로 던지고 `next(err)`로 넘긴다.
`errorHandler`가 `{ error: { message } }`로 응답하고, 500일 때만 `logger.error`로 남기며 `SENTRY_DSN`이 있으면
Sentry(`src/lib/sentry.ts`)로 보낸다.

### API 계약: OpenAPI

API 문서(OpenAPI 3.1)는 코드에서 생성한다. 요청 스키마는 `validate()`가 쓰는 `src/schemas/*.ts` 그대로이고,
응답 스키마는 `src/openapi/responses/`, 경로 등록(상태 코드별 응답과 오류 메시지)은 `src/openapi/paths/<도메인>.ts`에
있다. 모든 스키마는 `.openapi()`가 붙은 `z`(`src/lib/zod.ts`)를 import한다. `npm run openapi`가
`workbridge-server/openapi.json`을 쓰고 이 파일을 커밋한다(CI가 최신인지 확인). 문서는 `GET /api/docs`(Scalar)와
`GET /api/openapi.json`으로도 보이고, 프리뷰·로컬에서만 켜진다(허용 목록, `docs/ENV.md`의 `VERCEL_ENV`). 어긋남은 두 테스트가 막는다: `test/openapi.test.ts`가 앱의
라우트와 문서의 경로를 양방향으로 비교하고, `test/helpers/api.ts`의 `api()`·`authed()`가 모든 테스트의 응답을 문서의
응답 스키마(객체는 strict)로 검사한다(`test/helpers/openapi.ts`). 라우트를 추가하거나 응답 모양을 바꾸면 경로 등록과
응답 스키마도 함께 고친다.

## 데이터 모델

스키마는 `workbridge-server/prisma/schema.prisma`, 설명은 [DATABASE.md](DATABASE.md)에 있다. 중심 흐름:

```
User → Project → Application → Contract → Milestone ─┬→ Payment
                                   │                    ├→ MilestoneSubmission
                                   │                    └→ SettlementItem → Settlement
                                   ├→ Conversation → Message
                                   └→ Review
```

- `User`와 `Project`는 소프트 삭제(`deletedAt`)다. 읽기와 쓰기 모두 `deletedAt: null`로 거른다. 예외는
  가입 이메일 중복 확인, 정산과 지급 계좌다([domain/README.md](domain/README.md#소프트-삭제)).
- 여러 행을 바꾸는 변경은 `prisma.$transaction` 하나다. 같은 사용자의 쓰기가 섞이면 안 되는 곳(지급 계좌,
  포트폴리오·경력, 알림 설정)은 트랜잭션 첫 문장에서 `lockUserRow`(`src/lib/locks.ts`)로 사용자 행을 잠근다.

### 프로젝트 수명주기: GET이 행을 쓴다

`GET /api/projects`와 `GET /api/projects/:id`는 응답 전에 `closeExpiredOpenProjects()`
(`src/lib/projectLifecycle.ts`)를 부른다. 모집 시작일이 지난 `UPCOMING`을 `OPEN`으로, 마감이 지난 `UPCOMING`·`OPEN`을
`CLOSED`로 바꾸고 대기 중인 지원을 거절한다([지연 스윕](domain/projects-contracts.md#지연-스윕-읽기가-행을-쓴다)). 작업 큐의
`project.lifecycleSweep`도 10분마다 같은 함수를 부르지만, 운영에서는 작업 큐가 15분 간격으로만 돌아서 읽기 경로의
스윕이 보장 장치다.

## 작업 큐 (`src/jobs/`, Postgres `Job` 테이블)

- **넣기**: `enqueueJob(tx, …)`(`jobs/queue.ts`)를 상태 변경과 같은 트랜잭션에서 부른다(트랜잭션 아웃박스).
  변경이 롤백되면 작업도 남지 않는다. `dedupeKey`는 `createMany({ skipDuplicates: true })`로 처리한다.
- **꺼내기**: `runDueJobs`(`jobs/runner.ts`)가 `FOR UPDATE SKIP LOCKED`로 기한이 된 작업을 `RUNNING`으로 옮기고,
  `jobs/registry.ts`의 핸들러(`jobs/handlers/`)를 부른다. 핸들러는 멱등이고 시간은 `ctx.now`로 받는다.
- **반복 작업**: `jobs/recurring.ts` — 수명주기 스윕(10분), 정리(매일 04:00 KST), 주간 정산 배치(월요일 03:00 KST).
- **실행 주체**: 개발 서버가 띄우는 워커(`jobs/worker.ts`, `JOB_WORKER_ENABLED`), `npm run jobs:run`(한 번),
  `npm run jobs:worker`(상주), `POST /api/internal/jobs/run`. **운영(Vercel)에는 상주 프로세스가 없어서**
  GitHub Actions `jobs.yml`이 15분마다 내부 엔드포인트를 부른다. 작업은 예정 시각보다 최대 15분 늦게 돌고,
  지급·메일 작업은 플래그로 꺼져 있다([DEPLOYMENT.md](DEPLOYMENT.md#운영-환경의-한계)).

## 알림과 이메일

알림은 `notify()` / `notifyMany()`(`src/lib/notifications/notify.ts`)로만 만든다. 타입마다 정책
(`policy.ts`)과 받는 사람의 설정(`NotificationPreference`)을 보고 인앱 `Notification` 행, `EmailDelivery`,
`notification.email` 작업을 호출자의 트랜잭션 안에서 함께 쓴다. 문구는 `templates.ts`에 있다. 이메일은
작업 핸들러(`jobs/handlers/notificationEmail.ts`)가 `src/lib/mail/provider.ts`로 보내는데, 지금은 로그 provider뿐이라
`mail.sent` 로그 한 줄로 남는다.

## 금액과 시간

- `src/lib/money.ts`: 금액은 원 단위 정수. 수수료 10%와 수수료의 부가세 10%를 각각 내림하는
  `payoutBreakdown`, 합계를 항목의 합으로 내는 `sumBreakdowns`, 마일스톤 수와 최소 금액 상수.
  DB의 금액 컬럼은 `Float`인데, 알고 있는 부채로 남겨 둔다.
- `src/lib/time.ts`: 달력 계산은 고정 UTC+9(KST). CI와 Vercel은 UTC, 개발 PC는 KST라서 호스트 시간대를
  쓰지 않는다. 함수는 `now`를 인자로 받고, 테스트는 `now`를 넘겨 시간을 정한다.

## 클라이언트

- **App Router**: 화면별 폴더는 `src/app/`(`projects`, `contracts`, `settlements`, `messages`, `my` 등), 컴포넌트는 `src/components/`.
- **API 호출**: 모두 `src/lib/api.js`(Axios 인스턴스 하나). 액세스 토큰을 붙이고 401이면 `/api/auth/refresh`로 한 번
  갱신한다. 로그인·가입·역할 선택·로그아웃만 갱신 인터셉터가 없는 `src/lib/authApi.js`를 쓴다.
- **프록시**: `src/app/api/[...path]/route.js`가 `/api/*`를 서버로 전달하고, `src/app/api/auth/*`는
  `src/lib/server/authProxy.js`로 리프레시 토큰을 프론트엔드 쪽 `refreshToken` 쿠키로 다룬다. 서버 주소는
  `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다(`API_URL` → 프리뷰에서는 Vercel Related Projects → `NEXT_PUBLIC_API_URL`).
- **상태**: Zustand 스토어 `src/store/authStore.js`(토큰과 사용자, `localStorage`에 복사)와
  `src/store/projectStore.js`(목록 필터와 페이지).
- **`src/middleware.js`**: 보호 경로에 `refreshToken` 쿠키가 없으면 `/login`으로 보낸다. 쿠키가 있는지만 보고,
  실제 권한 확인은 서버가 한다.

## 환경

환경은 넷이다. **로컬**은 로컬 Postgres(테스트는 `workbridge_test`, E2E는 `workbridge_e2e`), **CI**는
GitHub Actions(`.github/workflows/ci.yml`, `e2e.yml`)가 띄우는 Postgres 서비스 컨테이너, **프리뷰**와 **운영**은
각각 Vercel Preview·Production 배포에 서로 다른 Supabase 프로젝트(DB)를 쓴다.
서버는 `@vercel/node`가 `src/index.ts`를 바로 트랜스파일해 서버리스 함수로 돌린다(`workbridge-server/vercel.json`,
빌드 단계와 `dist/` 없음). 운영에서는 `app.listen()`도 작업 워커도 시작하지 않는다. 파일 업로드는
Supabase Storage를 쓴다. 환경변수는 [ENV.md](ENV.md), 배포 절차와 운영 환경의 한계는 [DEPLOYMENT.md](DEPLOYMENT.md)에 있다.
