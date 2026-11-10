---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 서버 레이어 (workbridge-server/src)

## 기존 라우트와 확장 라우트 — 혼재는 의도된 것

- 요청 검증은 모든 라우트가 `src/schemas/`의 zod 스키마와 `validate()`로 한다.
- 기존 도메인(auth, users, projects, applications, contracts, payments, reviews, notifications)은
  컨트롤러 안에 로직을 둔다(`routes → controllers → lib`).
- 확장 도메인(milestones, settlements, payout account, contract list, conversations,
  portfolio/careers, recommendations, notification preferences)은
  `routes → controllers → services → lib`이다.
- 기존 컨트롤러를 서비스 레이어로 옮기는 일은 #40에서 한다. 다른 변경에 섞지 않는다.

## 새 라우트 만드는 법 (확장 방식)

- 체인: `authenticate → requireActiveUser → requireRole(...) → validate({ body|query|params }) → controller`.
  가드는 **라우트마다** 붙이고 `router.use`는 쓰지 않는다(같은 접두사에 나중에 마운트된 라우터로 가야 할
  요청까지 가드가 가로챈다).
- `validate()`는 파싱한 값을 `req.body`, `res.locals.query`, `res.locals.params`에 넣는다. multipart
  라우트(포트폴리오 이미지)에서는 `imageUpload` **다음에** 마운트한다.
- 컨트롤러는 얇게: 서비스를 부르고 `res.json(...)`, `catch (err) { next(err) }`.
- 비즈니스 로직, 트랜잭션, `AppError`는 `src/services/<domain>.service.ts`에 둔다.
- OpenAPI에 등록한다: 경로와 상태 코드별 응답·오류 메시지는 `src/openapi/paths/<domain>.ts`, 응답 모양은
  `src/openapi/responses/<domain>.ts`. `openapi.json`은 서버 파일을 고칠 때마다 PostToolUse 훅(`regen-openapi.sh`)이 다시 만든다. 바뀐 파일을 함께 커밋한다.
  등록하지 않으면 `test/openapi.test.ts`가, 응답이 문서와 다르면 그 라우트를 부르는 모든 테스트가 실패한다.
- 쓰기 라우트는 모두 `guardedMutations`(`test/soft-delete.test.ts`)와
  `PROTECTED_ROUTES`(`test/authorization.test.ts`)에 등록한다. 전체 단계: `add-endpoint` 스킬.

## 마운트 순서 (`src/index.ts`)

- `/api/users`: `userRoutes` 다음 `profileRoutes`, `/api/projects`: `projectRoutes` 다음
  `applicationRoutes`. 경로가 겹치면(`/me/*`, `/:id`) 먼저 마운트된 라우터가 이긴다. 순서는 절대 바꾸지
  않는다. 새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣는다.
- 라우터 안에서는 고정 경로를 파라미터보다 먼저 둔다(`/summary`가 `/:id`보다 먼저,
  `PUT /me/portfolio/order`가 `/me/portfolio/:itemId`보다 먼저).
- `import 'dotenv/config'`는 `index.ts`의 첫 import로 둔다.

## 에러

- `throw new AppError(message, statusCode)`(`lib/errors.ts`)로 던지고 `next(err)`로 넘긴다.
  컨트롤러에서 `res.status(4xx).json(...)`을 직접 쓰지 않는다.
- `errorHandler`는 매개변수 네 개를 모두 유지한다(Express는 인자 개수로 에러 핸들러를 알아본다).
- 핸들러에 `Promise<void>`를 붙이지 않는다 — 핸들러가 함수 중간에 `return res.json(...)`한다.
- 상태 코드: 잘못된 입력 → 400, 유니크 충돌 → 409, 외부 서비스 실패 → 502/400 — 500은 절대 아니다.
  500은 버그라서 OpenAPI 문서에 넣지 않는다. 기존 응답 코드를 바꾸면 `src/openapi/paths`도 고친다.

## req.user

- non-optional로 타입이 잡혀 있지만(`src/types/index.ts`) 거기 적힌 공개 핸들러 15개에서는 `undefined`다
  (`signup`, `login`, `logout`, `refresh`, `googleAuth`, `googleCallback`, `getProjects`, `getProjectById`,
  `getUserById`, `getUserReviews`, `getUserPortfolio`, `getUserCareers`, `runJobs`,
  `getOpenApiDocument`, `getDocsPage`).
  컴파일러는 경고하지 않는다. 보완 장치는 `test/authorization.test.ts`다.
- 모든 라우트에서 도는 미들웨어(`accessLog`)는 optional로 읽는다.

## 트랜잭션

- 행 두 개 이상을 바꾸는 변경은 `prisma.$transaction` 하나다(`docs/domain/README.md` "원자성"). 기준 예:
  `applications.controller.ts`의 지원 수락(지원, 다른 지원 거절, 계약 + 기본 마일스톤, 프로젝트 마감,
  알림, 대화방 + 시스템 메시지).
- 트랜잭션 안팎에서 모두 쓰는 헬퍼는 `PrismaTransactionClient`를 받는다
  (`src/types/index.ts`, `lib/projectLifecycle.ts` 참고).
- 인터랙티브 트랜잭션 *안에서* P2002를 catch하지 않는다 — Postgres가 이미 트랜잭션을 중단했다.
  `createMany({ skipDuplicates: true })`(`jobs/queue.ts` 참고)를 쓰거나 밖에서 catch한다(지원 수락의 방식).
- 트랜잭션이 지급 계좌, 포트폴리오/경력, 알림 설정을 쓸 때와 주간 정산 배치(`settleFreelancer`)는
  `lockUserRow(tx, userId)`가 **첫** 문장이다(경합 테스트가 여기에 의존한다). 정산 배치는 지급 결정과 같은
  `User` → `Settlement` 순서여야 한다: 한 트랜잭션에서 같은 행을 두 번 쓰면 FK 부모 행도 잠겨서 교착한다(#79).

## 그 밖

- 타입: 공유 타입은 `src/types/index.ts`, 환경변수는 `src/env.ts`, 모델·enum·`WhereInput`은
  `@prisma/client`에서 import한다. 직접 만들지 않는다.
- AI 단가 분석(`analyzeProject`): 모델이 준 JSON은 저장하기 전에 항상 정규화한다.
- 업로드: 기존 프로필 이미지 → `middlewares/upload.ts`(크기·형식 오류가 아직 500이다), 포트폴리오 이미지 →
  `middlewares/attachmentUpload.ts`의 `imageUpload`(413/400, 저장소 실패 502). 메시지·결과물 첨부는 서버를 거치지
  않는다: `services/attachments.service.ts`가 서명 업로드 URL을 주고 `uploadIds`를 검증하며, 응답의 첨부는
  `presignAttachments()`로 서명 URL을 단다(비공개 버킷, `lib/attachmentStorage.ts`).
