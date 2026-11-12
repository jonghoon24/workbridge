# 구조

WorkBridge의 코드가 어디에 무엇이 있고 왜 그렇게 나뉘었는지 정리한다. 제품 규칙은 [domain/](domain/README.md), API 계약은
OpenAPI 문서(아래 "API 계약: OpenAPI")가 기준이다.
패키지는 `workbridge-server/`(Express + Prisma, TypeScript, 진입점 `src/index.ts`)와 `workbridge-client/`
(Next.js 14 App Router, JSX) 둘이다. 브라우저는 클라이언트의 같은 출처 `/api/*`만 부르고, Next 라우트
핸들러가 서버로 전달한다.

## 서버 요청 흐름

`src/index.ts`가 공통 미들웨어(요청 ID와 접근 로그, CORS, 본문·쿠키 파서, 요청 컨텍스트) → 도메인 라우터
(`src/routes/*.routes.ts`) → `notFound` → `errorHandler` 순으로 건다. 같은 접두어에 라우터가 둘인 곳(`/api/users`,
`/api/projects`)은 경로가 겹치면 먼저 마운트된 쪽이 이긴다. 오류는 `AppError(code, message)`로 던져 `errorHandler`가
`{ error: { code, message } }`(검증 실패는 `fields`도)로 응답한다. 코드와 그 상태 코드는 `src/lib/errorCodes.ts`의 표 하나가
정하고, `AppError`가 아닌 오류는 모두 500 `INTERNAL_ERROR`다.

### 레이어

모든 도메인이 `routes → controllers → services → lib` 구조다. 라우트를 만들 때 지킬 것은
[server-layers.md](../.claude/rules/server-layers.md)에 있다.

- **라우트**(`src/routes/`): 가드와 요청 검증. 검증은 zod 스키마(`src/schemas/`)와 `validate()`(`src/middlewares/validate.ts`)가
  맡는다.
- **컨트롤러**(`src/controllers/`): 검증된 입력, `req.user`, 요청 시각(`now`)을 서비스에 넘기고 응답(상태 코드, 쿠키,
  리다이렉트)만 쓴다. 컨트롤러 안의 로직은 작업 핸들러나 다른 서비스가 다시 쓸 수 없어서, 로직은 서비스에 둔다.
- **서비스**(`src/services/*.service.ts`): 쿼리, 트랜잭션과 잠금, 알림·작업 생성, `AppError`. 여러 서비스가 함께 쓰는 로직은
  `src/lib/`에 있다(지연 스윕 `lib/projectLifecycle.ts`, 사용자 행 잠금 `lib/locks.ts` 등). 추천 프로젝트 조회는 읽기만
  하므로 서비스 없이 컨트롤러가 `lib/recommendations.ts`를 바로 부른다.

### 인증과 권한

- `authenticate`(`src/middlewares/auth.ts`): `Authorization: Bearer <access token>`을 검증해 `req.user`를 채운다(실패 401).
  공개 핸들러에서는 `req.user`가 없다(목록은 `src/types/index.ts`).
- 가드는 라우트마다 체인으로 건다. 순서는 [server-layers.md](../.claude/rules/server-layers.md) "라우트 만드는 법"에 있다.
  소유권은 서비스가 확인한다. 프로필 완성이 필요한 라우트(프로젝트 등록, 지원, 추천 프로젝트)는
  `requireCompleteProfile`(`src/middlewares/profile.ts`)도 거친다.
- 탈퇴(소프트 삭제)한 사용자의 요청은 `requireActiveUser`(`src/middlewares/activeUser.ts`)가 401로 막는다. 쓰기 라우트에는
  이 가드가 붙는다. 일부 읽기 라우트, 역할 선택, 로그아웃, 언제나 410인 `PATCH /api/contracts/:id`에는 없다. 탈퇴한 사용자는
  남은 액세스 토큰으로 만료 때까지 그 읽기를 할 수 있다([accounts.md](domain/accounts.md#탈퇴한-뒤)). 가드가 없는 라우트
  목록은 `activeUser.ts` 머리 주석에 있다.
- 되돌릴 수 없는 작업 직전의 본인 재확인: 비밀번호 계정은 현재 비밀번호, Google 전용 계정은 Google 재인증
  (`src/services/reauth.service.ts`). 재인증의 결과는 저장하지 않고 짧게 사는 서명 토큰(`src/lib/reauth.ts`)으로 브라우저에
  주며, 그 작업의 서비스가 `assertRecentGoogleReauth`로 검사한다. 지금은 회원 탈퇴만 쓴다.
- 로그인과 비밀번호 확인에는 `rateLimit`(`src/middlewares/rateLimit.ts`, 카운터는 `RateLimitCounter` 테이블)이 붙는다.
  `POST /api/internal/jobs/run`은 JWT 대신 `requireInternalToken`(`X-Internal-Token`)으로 지킨다.

### API 계약: OpenAPI

API 문서(OpenAPI 3.1)는 코드에서 생성한다. 요청 스키마는 `validate()`가 쓰는 `src/schemas/*.ts` 그대로이고,
응답 스키마는 `src/openapi/responses/`, 경로 등록(상태 코드별 응답과 그 오류 코드)은 `src/openapi/paths/<도메인>.ts`에
있다. 모든 스키마는 `.openapi()`가 붙은 `z`(`src/lib/zod.ts`)를 import한다. `npm run openapi`가 커밋되는
`workbridge-server/openapi.json`을 쓴다. 문서는 `GET /api/docs`(Scalar)와 `GET /api/openapi.json`으로도 보이고, 프로덕션에서는
꺼진다(켜지는 조건은 `src/controllers/docs.controller.ts` 머리 주석).

문서와 코드가 어긋나면 테스트가 실패한다. `test/openapi.test.ts`는 앱의 라우트와 문서의 경로를 양방향으로 비교하고,
테스트 헬퍼는 모든 응답을 문서의 응답 스키마와 대조한다([tests.md](../.claude/rules/tests.md)).

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

프로젝트·지원을 읽는 일부 GET은 응답 전에 모집 상태를 맞추면서 행을 쓴다(지연 스윕, 결정과 이유는
[projects-contracts.md](domain/projects-contracts.md#지연-스윕-읽기가-행을-쓴다)). 어느 핸들러가 쓰는지는
`src/lib/projectLifecycle.ts`의 두 함수를 부르는 곳으로 확인한다.

## 작업 큐 (`src/jobs/`, Postgres `Job` 테이블)

- **넣기**: 상태 변경과 같은 트랜잭션에서 `enqueueJob(tx, …)`(`jobs/queue.ts`)로 넣는다(트랜잭션 아웃박스). 변경이
  롤백되면 작업도 남지 않는다([domain/README.md "원자성"](domain/README.md#원자성)). 같은 `dedupeKey`로 다시 넣으면 무시된다.
- **꺼내기**: `runDueJobs`(`jobs/runner.ts`)가 `FOR UPDATE SKIP LOCKED`로 기한이 된 작업을 가져가
  `jobs/registry.ts`의 핸들러(`jobs/handlers/`)를 부른다. 핸들러는 멱등이고 시간은 `ctx.now`로 받는다.
- **반복 작업**: `jobs/recurring.ts`(수명주기 스윕, 정리, 주간 정산 배치). 슬롯마다 `dedupeKey`가 있어 여러 번 넣어도 하나다.
- **실행 주체**: 개발 서버가 띄우는 워커(`jobs/worker.ts`), `npm run jobs:run`(한 번), `npm run jobs:worker`(상주),
  `POST /api/internal/jobs/run`. 프로덕션에서 누가 언제 돌리는지와 꺼 둔 작업은
  [DEPLOYMENT.md "프로덕션 환경의 한계"](DEPLOYMENT.md#프로덕션-환경의-한계)에 있다.

## 알림과 이메일

알림은 `src/lib/notifications/notify.ts`의 `notify()`, `notifyMany()`, `notifyRecipients()`가 만든다
([notifications-logging.md](../.claude/rules/notifications-logging.md)). 이 함수들은 타입별 정책(`policy.ts`)과 받는 사람의
설정을 보고 인앱 알림, 이메일 발송 기록, `notification.email` 작업을 호출자의 트랜잭션 안에서 함께 쓴다.
`notifyRecipients()`는 소프트 삭제된 받는 사람을 거른다. 이메일은 작업 핸들러가 `src/lib/mail/provider.ts`로 보낸다. 프로덕션에서
메일이 어떻게 처리되는지는 [DEPLOYMENT.md "이메일은 로그로만 나간다"](DEPLOYMENT.md#4-이메일은-로그로만-나간다)에 있다.

## 금액과 시간

금액 계산은 `src/lib/money.ts`, 달력 계산(고정 UTC+9)은 `src/lib/time.ts`에 모여 있다. 규칙과 이유는
[milestones-payments.md](domain/milestones-payments.md)와 [domain/README.md](domain/README.md)의 "시간대", DB 금액 컬럼이
`Float`인 부채는 [DATABASE.md](DATABASE.md#금액이-float인-부채)에 있다.

## 클라이언트

지킬 것은 [client.md](../.claude/rules/client.md)에 있다. 여기서는 구조만 적는다.

- **App Router**: 화면별 폴더는 `src/app/`(`projects`, `contracts`, `settlements`, `messages`, `my` 등), 컴포넌트는 `src/components/`.
- **API 호출**: `src/lib/api.js`(Axios 인스턴스 하나)가 액세스 토큰을 붙이고, 401이면 `/api/auth/refresh`로 한 번
  갱신한다. 로그인·가입·역할 선택·로그아웃은 갱신 인터셉터가 없는 `src/lib/authApi.js`로 부른다.
- **프록시**: 프록시는 두 종류다.
  - 일반 프록시 `src/app/api/[...path]/route.js`는 `/api/*` 요청을 서버로 전달한다. 쿠키는 주고받지 않는다.
  - 리프레시 토큰은 프론트엔드 출처의 `refreshToken` 쿠키에 있다. 이 쿠키를 서버로 보내거나 서버가 새로 준 쿠키를
    브라우저에 심어야 하는 요청은 `src/app/api/auth/` 아래의 전용 라우트가 맡는다. 전용 라우트는
    `src/lib/server/authProxy.js`로 쿠키를 옮긴다. 리프레시 쿠키를 새로 주는 서버 경로를 더하면 전용 라우트도 만든다.
    `change-password`도 새 리프레시 쿠키를 받으므로 전용 라우트가 있다. 로그인한 사용자가 부르는 요청이라 브라우저는
    갱신 인터셉터가 있는 `api.js`로 부른다.
  - 서버 주소는 서버 쪽 코드에서만 `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다(우선순위는 그 파일 머리 주석).
- **상태**: Zustand 스토어 두 개다. `src/store/authStore.js`는 사용자 정보를 `localStorage`에 복사해 둔다. 액세스 토큰은
  `localStorage`에만 두고 `src/lib/api.js`의 인터셉터가 읽고 갱신한다. `src/store/projectStore.js`는 프로젝트 목록의 필터와
  페이지를 둔다.
- **`src/middleware.js`**: 보호 경로에 `refreshToken` 쿠키가 없으면 `/login`으로 보낸다. 쿠키가 있는지만 보고,
  실제 권한 확인은 서버가 한다.

## 환경

환경은 로컬, CI, 프리뷰, 프로덕션 넷이다(구분과 DB는 [DEPLOYMENT.md](DEPLOYMENT.md#환경)). 프로덕션에서 서버는 Vercel 서버리스 함수로
돈다(빌드 방식과 프로덕션에서 시작하지 않는 것은 [DEPLOYMENT.md "백엔드"](DEPLOYMENT.md#백엔드)).
파일은 Supabase Storage에 둔다. 프로필·포트폴리오 이미지는 서버가 받아 공개 버킷에 올린다. 메시지·결과물 첨부는 브라우저가
서명 업로드 URL로 비공개 버킷에 직접 올리고, 읽을 때는 서명 URL을 받는다. 환경변수는 각 패키지의 `.env.example`, 환경별로
어디에 넣는지는 [ENV.md](ENV.md), 배포 절차와 프로덕션 환경의 한계는 [DEPLOYMENT.md](DEPLOYMENT.md)에 있다.
