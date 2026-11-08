---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 서버 레이어 (workbridge-server/src)

## 기존 라우트와 확장 라우트 — 혼재는 의도된 것

- 기존 도메인(auth, users, projects, applications, contracts, payments, reviews, notifications)은
  컨트롤러 안에 로직과 수동 검사를 그대로 둔다(`routes → controllers → lib`).
- 확장 도메인(milestones, settlements, payout account, contract list, conversations,
  portfolio/careers, recommendations, notification preferences)은
  `routes → controllers → services → lib`이고 zod 스키마는 `src/schemas/`에 있다.
- 정리한다는 이유로 기존 컨트롤러(auth, users, projects, applications, contracts, payments, reviews, notifications)에 zod `validate()`, 서비스 레이어, `requireActiveUser`를 추가하지 않는다. `it.fails` 핀(예: `soft-delete.test.ts`의 D12)이 지금 동작에 묶여 있다. 유일한 예외는 같은 변경에서 그 핀을 뒤집는 의도적인 불일치 수정(`fix-divergence` 스킬)이다.
- 이유: `it.fails` 핀이 옛 동작에 묶여 있다 — 예를 들어 `test/soft-delete.test.ts`의 D12
  (`mutations`): 소프트 삭제된 사용자가 옛 라우트에서는 아직 쓰기를 할 수 있다. 가드를 하나 붙이면
  핀이 예기치 않게 통과해 스위트가 실패한다. 불일치 수정은 별도 작업이다(`fix-divergence` 스킬).

## 새 라우트 만드는 법 (확장 방식)

- 체인: `authenticate → requireActiveUser → requireRole(...) → validate({ body|query|params }) → controller`.
  가드는 **라우트마다** 붙이고 `router.use`는 쓰지 않는다(맞지 않는 경로는 그대로 다음으로 넘어가야 한다 — Q10).
- `validate()`는 파싱한 값을 `req.body`, `res.locals.query`, `res.locals.params`에 넣는다. multipart
  라우트에서는 `attachmentUpload` / `imageUpload` **다음에** 마운트한다.
- 컨트롤러는 얇게: 서비스를 부르고 `res.json(...)`, `catch (err) { next(err) }`.
- 비즈니스 로직, 트랜잭션, `AppError`는 `src/services/<domain>.service.ts`에 둔다.
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
- 상태 코드 규칙(BEHAVIOR.md 규칙 8): 잘못된 입력 → 400, 유니크 충돌 → 409,
  외부 서비스 실패 → 502/400 — 500은 절대 아니다.

## req.user

- non-optional로 타입이 잡혀 있지만(`src/types/index.ts`) 거기 적힌 공개 핸들러 12개에서는 `undefined`다
  (`signup`, `login`, `refresh`, `googleAuth`, `googleCallback`, `getProjects`, `getProjectById`,
  `getUserById`, `getUserReviews`, `getUserPortfolio`, `getUserCareers`, `runJobs`).
  컴파일러는 경고하지 않는다. 보완 장치는 `test/authorization.test.ts`다.
- 모든 라우트에서 도는 미들웨어(`accessLog`)는 optional로 읽는다.

## 트랜잭션

- 행 두 개 이상을 바꾸는 변경은 `prisma.$transaction` 하나다(BEHAVIOR.md 규칙 6). 기준 예:
  `applications.controller.ts`의 지원 수락(지원, 다른 지원 거절, 계약 + 기본 마일스톤, 프로젝트 마감,
  알림, 대화방 + 시스템 메시지).
- 트랜잭션 안팎에서 모두 쓰는 헬퍼는 `PrismaTransactionClient`를 받는다
  (`src/types/index.ts`, `lib/projectLifecycle.ts` 참고).
- 인터랙티브 트랜잭션 *안에서* P2002를 catch하지 않는다 — Postgres가 이미 트랜잭션을 중단했다.
  `createMany({ skipDuplicates: true })`(`jobs/queue.ts` 참고)를 쓰거나 밖에서 catch한다(D4 수정 방식).
- 트랜잭션이 지급 계좌, 포트폴리오/경력, 알림 설정을 쓸 때는 `lockUserRow(tx, userId)`가
  **첫** 문장이다(경합 테스트가 여기에 의존한다).

## 그 밖

- 타입: 공유 타입은 `src/types/index.ts`, 환경변수는 `src/env.ts`, 모델·enum·`WhereInput`은
  `@prisma/client`에서 import한다. 직접 만들지 않는다.
- AI 단가 분석(`analyzeProject`): 모델이 준 JSON은 저장하기 전에 항상 정규화한다.
- 업로드: 옛 프로필 이미지 → `middlewares/upload.ts`(500이 날 수 있다, D6), 확장 →
  `middlewares/attachmentUpload.ts`(413/400, 저장소 실패 502).
