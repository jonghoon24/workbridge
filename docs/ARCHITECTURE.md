# 구조

WorkBridge의 코드가 어디에 무엇이 있고 왜 그렇게 나뉘었는지 정리한다. 제품 규칙은 [domain/](domain/README.md), API 계약은
OpenAPI 문서(아래 "API 계약: OpenAPI")가 기준이다.
패키지는 `workbridge-server/`(Express + Prisma, TypeScript, 진입점 `src/index.ts`)와 `workbridge-client/`
(Next.js 14 App Router, JSX) 둘이다. 브라우저는 클라이언트의 같은 출처 `/api/*`만 부르고, Next 라우트
핸들러가 서버로 전달한다.

## 서버 요청 흐름

`src/index.ts`가 공통 미들웨어(요청 ID와 접근 로그, CORS, 본문·쿠키 파서, 요청 컨텍스트) → 도메인 라우터
(`src/routes/*.routes.ts`) → `notFound` → `errorHandler` 순으로 건다. 같은 접두어에 라우터가 둘인 곳(`/api/users`,
`/api/projects`)은 경로가 겹치면 먼저 마운트된 쪽이 이긴다. 오류는 `AppError`로 던져 `errorHandler`가
`{ error: { message } }`로 응답한다.

### 레이어: 기존 도메인과 확장 도메인

| | 기존 도메인 | 확장 도메인 |
| --- | --- | --- |
| 도메인 | auth, users, projects, applications, contracts, payments, notifications | milestones, settlements, payout account, contract list, conversations, portfolio/careers, recommendations, notification preferences, bookmark ids, reviews |
| 흐름 | `routes → controllers → lib` | `routes → controllers → services → lib` |
| 로직 | 컨트롤러 안 | `src/services/*.service.ts`, 일부는 `src/lib/`(추천은 `lib/recommendations.ts`) |
| 소프트 삭제된 호출자 | 쓰기 라우트만 `requireActiveUser`가 401. 읽기 라우트는 다시 확인하지 않는다 | 모든 라우트에서 `requireActiveUser`(`src/middlewares/activeUser.ts`)가 401 |

요청 검증은 양쪽 모두 zod 스키마(`src/schemas/`)와 `validate()`(`src/middlewares/validate.ts`)가 맡는다. 확장 라우트가 기존
라우터 파일에 들어간 곳도 있다(지급 계좌 `users.routes.ts`, 계약 목록 `contracts.routes.ts`, 추천 프리랜서 `projects.routes.ts`).
두 방식이 섞여 있는 것은 의도된 과도기이고, 기존 도메인을 서비스 레이어로 옮기는 계획과 순서는
[#40](https://github.com/jonghoon24/workbridge/issues/40)에 있다. #40에서 옮긴 auth, users, notifications(설정 제외), payments는
로직이 `src/services/`에 있지만, 읽기 라우트와 역할 선택에는 `requireActiveUser`가 없어(#7은 쓰기만 막고, 역할 선택은
서비스가 직접 404로 막는다) 표에서는 기존 도메인에 둔다.

### 인증과 권한

- `authenticate`(`src/middlewares/auth.ts`): `Authorization: Bearer <access token>`을 검증해 `req.user`를 채운다(실패 401).
  공개 핸들러에서는 `req.user`가 없다(목록은 `src/types/index.ts`).
- 확장 라우트의 체인: `authenticate → requireActiveUser → requireRole(...) → [업로드] → validate → controller`.
- 기존 라우트는 `authenticate → requireRole(...) → validate` 뒤에 컨트롤러가 소유권을 직접 확인한다.
  프로젝트 등록은 `requireCompleteProfile`(`src/middlewares/profile.ts`)도 거친다.
- 되돌릴 수 없는 작업 직전의 본인 재확인: 비밀번호 계정은 현재 비밀번호, Google 전용 계정은 Google 재인증
  (`src/services/reauth.service.ts`). 재인증의 결과는 저장하지 않고 짧게 사는 서명 토큰(`src/lib/reauth.ts`)으로 브라우저에
  주며, 그 작업의 서비스가 `assertRecentGoogleReauth`로 검사한다. 지금은 회원 탈퇴만 쓴다.
- 로그인과 AI 분석에는 `rateLimit`(`src/middlewares/rateLimit.ts`, 카운터는 `RateLimitCounter` 테이블)이 붙는다.
  `POST /api/internal/jobs/run`은 JWT 대신 `requireInternalToken`(`X-Internal-Token`)으로 지킨다.

### API 계약: OpenAPI

API 문서(OpenAPI 3.1)는 코드에서 생성한다. 요청 스키마는 `validate()`가 쓰는 `src/schemas/*.ts` 그대로이고,
응답 스키마는 `src/openapi/responses/`, 경로 등록(상태 코드별 응답과 오류 메시지)은 `src/openapi/paths/<도메인>.ts`에
있다. 모든 스키마는 `.openapi()`가 붙은 `z`(`src/lib/zod.ts`)를 import한다. `npm run openapi`가 커밋되는
`workbridge-server/openapi.json`을 쓴다. 문서는 `GET /api/docs`(Scalar)와 `GET /api/openapi.json`으로도 보이고, 운영에서는
꺼진다([ENV.md](ENV.md)의 `VERCEL_ENV`). 어긋남은 두 테스트가 막는다: `test/openapi.test.ts`가 앱의 라우트와 문서의 경로를
양방향으로 비교하고, `test/helpers/api.ts`의 `api()`·`authed()`가 모든 테스트의 응답을 문서의 응답 스키마(객체는 strict)로
검사한다(`test/helpers/openapi.ts`).

## 데이터 모델

스키마는 `workbridge-server/prisma/schema.prisma`, 불변식·잠금은 [DATABASE.md](DATABASE.md)에 있다. 중심 흐름:

```
User → Project → Application → Contract → Milestone ─┬→ Payment
                                   │                    ├→ MilestoneSubmission
                                   │                    └→ SettlementItem → Settlement
                                   ├→ Conversation → Message
                                   └→ Review
```

### 프로젝트 수명주기: GET이 행을 쓴다

프로젝트 상태를 시각에 맞춰 바꿔 줄 상주 프로세스가 운영에 없어서, 프로젝트·지원을 읽는 경로가 응답 전에 상태를 맞춘다
([지연 스윕](domain/projects-contracts.md#지연-스윕-읽기가-행을-쓴다)). 공개 목록·상세뿐 아니라 내 지원·내 프로젝트·프로젝트의
지원 목록 같은 GET도 행을 쓴다. 어느 핸들러가 쓰는지는 `src/lib/projectLifecycle.ts`의 `closeExpiredOpenProjects`와
`rejectPendingApplicationsForClosedProjects`를 부르는 곳(projects·applications 컨트롤러와 users 서비스)이 기준이다. 작업 큐의
`project.lifecycleSweep`도 같은 함수를 부르지만, 운영에서는 작업 큐가 15분 간격으로만 돌아서 읽기 경로의 스윕이 보장 장치다.

## 작업 큐 (`src/jobs/`, Postgres `Job` 테이블)

- **넣기**: `enqueueJob(tx, …)`(`jobs/queue.ts`)를 상태 변경과 같은 트랜잭션에서 부른다(트랜잭션 아웃박스).
  변경이 롤백되면 작업도 남지 않는다. 같은 `dedupeKey`로 다시 넣으면 무시된다.
- **꺼내기**: `runDueJobs`(`jobs/runner.ts`)가 `FOR UPDATE SKIP LOCKED`로 기한이 된 작업을 가져가
  `jobs/registry.ts`의 핸들러(`jobs/handlers/`)를 부른다. 핸들러는 멱등이고 시간은 `ctx.now`로 받는다.
- **반복 작업**: `jobs/recurring.ts`(수명주기 스윕, 정리, 주간 정산 배치). 슬롯마다 `dedupeKey`가 있어 여러 번 넣어도 하나다.
- **실행 주체**: 개발 서버가 띄우는 워커(`jobs/worker.ts`), `npm run jobs:run`(한 번), `npm run jobs:worker`(상주),
  `POST /api/internal/jobs/run`. **운영(Vercel)에는 상주 프로세스가 없어서** GitHub Actions `jobs.yml`이 내부 엔드포인트를
  주기적으로 부르고, 지급·메일 작업은 플래그로 꺼져 있다([DEPLOYMENT.md](DEPLOYMENT.md#운영-환경의-한계)).

## 알림과 이메일

알림은 `notify()` / `notifyMany()`(`src/lib/notifications/notify.ts`)로만 만든다. 타입별 정책(`policy.ts`)과 받는 사람의
설정을 보고 인앱 알림, 이메일 발송 기록, `notification.email` 작업을 호출자의 트랜잭션 안에서 함께 쓴다. 이메일은 작업
핸들러가 `src/lib/mail/provider.ts`로 보내는데, 지금은 로그 provider뿐이다([DEPLOYMENT.md](DEPLOYMENT.md#운영-환경의-한계) 4번).

## 금액과 시간

금액 계산은 `src/lib/money.ts`, 달력 계산(고정 UTC+9)은 `src/lib/time.ts`에 모여 있다. 규칙과 이유는
[milestones-payments.md](domain/milestones-payments.md)와 [domain/README.md](domain/README.md)의 "시간대", DB 금액 컬럼이
`Float`인 부채는 [DATABASE.md](DATABASE.md#금액이-float인-부채)에 있다.

## 클라이언트

- **App Router**: 화면별 폴더는 `src/app/`(`projects`, `contracts`, `settlements`, `messages`, `my` 등), 컴포넌트는 `src/components/`.
- **API 호출**: 모두 `src/lib/api.js`(Axios 인스턴스 하나). 액세스 토큰을 붙이고 401이면 `/api/auth/refresh`로 한 번
  갱신한다. 로그인·가입·역할 선택·로그아웃만 갱신 인터셉터가 없는 `src/lib/authApi.js`를 쓴다.
- **프록시**: `src/app/api/[...path]/route.js`가 `/api/*`를 서버로 전달하고, `src/app/api/auth/*`는
  `src/lib/server/authProxy.js`로 리프레시 토큰을 프론트엔드 쪽 `refreshToken` 쿠키로 다룬다. 일반 프록시는 쿠키를 주고받지
  않으므로, 리프레시 쿠키를 새로 심는 서버 경로는 `/api/auth/*` 아래에 두고 전용 라우트를 만든다(로그인한 사용자가 부르는
  `change-password`는 `api.js`로 부른다). 서버 주소는 서버 쪽 코드에서만
  `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다(우선순위는 그 파일 머리 주석).
- **상태**: Zustand 스토어 `src/store/authStore.js`(사용자, `localStorage`에 복사. 액세스 토큰은 `localStorage`에만
  두고 `src/lib/api.js`의 인터셉터가 읽고 갱신한다)와
  `src/store/projectStore.js`(목록 필터와 페이지).
- **`src/middleware.js`**: 보호 경로에 `refreshToken` 쿠키가 없으면 `/login`으로 보낸다. 쿠키가 있는지만 보고,
  실제 권한 확인은 서버가 한다.

## 환경

환경은 로컬, CI, 프리뷰, 운영 넷이다(구분과 DB는 [DEPLOYMENT.md](DEPLOYMENT.md#환경)). 서버는 `@vercel/node`가 `src/index.ts`를
바로 트랜스파일해 서버리스 함수로 돌린다(빌드 단계와 `dist/` 없음). 운영에서는 `app.listen()`도 작업 워커도 시작하지 않는다.
파일은 Supabase Storage에 둔다: 프로필·포트폴리오 이미지는 서버가 받아 공개 버킷에 올리고, 메시지·결과물 첨부는 브라우저가
서명 업로드 URL로 비공개 버킷에 직접 올린다(읽을 때는 서명 URL). 환경변수는 [ENV.md](ENV.md), 배포 절차와 운영 환경의 한계는
[DEPLOYMENT.md](DEPLOYMENT.md)에 있다.
