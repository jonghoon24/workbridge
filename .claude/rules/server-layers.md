---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 서버 레이어 (workbridge-server/src)

## 기존 라우트와 확장 라우트

- 새 라우트는 아래 확장 방식으로 만든다. 로직이 컨트롤러 안에 있는 기존 라우트는 고칠 때도 그 방식을 유지한다.
- 기존 컨트롤러의 로직을 서비스 레이어로 옮기는 일은 #40에서 도메인 단위로 한다(대상 도메인은 `REVIEW.md` #2).
  다른 변경에 섞지 않는다.

## 새 라우트 만드는 법 (확장 방식)

- 체인: `authenticate → requireActiveUser → requireRole(...) → validate({ body|query|params }) → controller`.
  가드는 **라우트마다** 붙이고 `router.use`는 쓰지 않는다(같은 접두사에 나중에 마운트된 라우터로 가야 할
  요청까지 가드가 가로챈다).
- `validate()`는 파싱한 값을 `req.body`, `res.locals.query`, `res.locals.params`에 넣는다(`req.query`가 아니다).
  multipart 라우트(포트폴리오 이미지)에서는 `imageUpload` **다음에** 마운트한다.
- 컨트롤러는 얇게: 서비스를 부르고 `res.json(...)`, `catch (err) { next(err) }`. 비즈니스 로직, 트랜잭션,
  `AppError`는 `src/services/<domain>.service.ts`에 둔다.
- 환경변수는 `src/env.ts`의 getter로만 읽는다(`process.env` 직접 읽기 금지).
- 파일 첨부는 multipart로 받지 않는다: 서명 업로드 URL과 `uploadIds`(`services/attachments.service.ts`)를 쓴다.
- OpenAPI에 등록한다: 경로와 상태 코드별 응답·오류 메시지는 `src/openapi/paths/<domain>.ts`, 응답 모양은
  `src/openapi/responses/<domain>.ts`. 테스트가 모든 응답을 이 문서와 strict하게 대조하므로 문서에 없는 상태 코드나
  필드는 테스트 실패다. 다시 만든 `openapi.json`을 함께 커밋한다.
- 쓰기 라우트는 모두 `guardedMutations`(`test/soft-delete.test.ts`)와
  `PROTECTED_ROUTES`(`test/authorization.test.ts`)에 등록한다. 전체 단계: `add-endpoint` 스킬.

## 마운트 순서 (`src/index.ts`)

- `/api/users`는 `userRoutes` 다음 `profileRoutes`, `/api/projects`는 `projectRoutes` 다음 `applicationRoutes`다.
  경로가 겹치면(`/me/*`, `/:id`) 먼저 마운트된 라우터가 이긴다. 순서를 바꾸지 않는다.
  새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣는다.
- 라우터 안에서는 고정 경로를 파라미터 경로(`/:id`)보다 먼저 둔다.

## 에러

- `throw new AppError(message, statusCode)`(`lib/errors.ts`)로 던지고 `next(err)`로 넘긴다.
  컨트롤러에서 `res.status(4xx).json(...)`을 직접 쓰지 않는다.
- 상태 코드: 잘못된 입력 → 400, 유니크 충돌 → 409, 외부 서비스 실패 → 502/400 — 500은 절대 아니다.
  500은 버그라서 OpenAPI 문서에 넣지 않는다.

## req.user

- non-optional로 타입이 잡혀 있지만 공개 핸들러(`authenticate` 없이 마운트된 핸들러, 목록은
  `src/types/index.ts`의 `Request.user` 주석)에서는 `undefined`다. 컴파일러는 경고하지 않는다. 거기서는 읽지 않는다.
  공개 핸들러를 추가하면 그 주석과 `test/authorization.test.ts`의 `PUBLIC_ROUTES`에 함께 넣는다.

## 트랜잭션과 잠금

- 행 두 개 이상을 바꾸는 변경은 `prisma.$transaction` 하나다. 알림(`notify()`)과 작업(`enqueueJob()`)도 그 트랜잭션
  클라이언트로 쓴다 — 롤백된 변경이 알림이나 작업을 남기면 안 된다(`docs/domain/README.md` "원자성").
  기준 예: `applications.controller.ts`의 지원 수락.
- 트랜잭션 안팎에서 모두 쓰는 헬퍼는 `PrismaTransactionClient`(`src/types/index.ts`)를 받는다.
- 인터랙티브 트랜잭션 *안에서* `create` 후 P2002를 catch하지 않는다 — Postgres가 처음 실패한 문장에서 트랜잭션 전체를
  이미 중단했다. `createMany({ skipDuplicates: true })`(`jobs/queue.ts` 참고)를 쓰거나 트랜잭션 밖에서 catch해 409로 바꾼다.
- 지급 계좌, 포트폴리오/경력, 알림 설정을 쓰는 트랜잭션과 주간 정산 배치(`settleFreelancer`)는
  `lockUserRow(tx, userId)`가 **첫** 문장이다. 사용자 요청 경로는 `lockActiveUserRow`를 써서, 기다리는 사이에 탈퇴한
  사용자의 데이터를 되살리지 않는다. 정산은 지급 결정과 같은 `User` → `Settlement` 순서로 잡는다
  (거꾸로 잡으면 교착한다, #79). 회원 탈퇴만 지원 수락과 같은 `Project` → `Application` → `User` 순서다(REVIEW #6).
- 대화방 시스템 메시지(`postSystemMessage`)는 이벤트 트랜잭션의 **마지막 쓰기**로 부른다. `Conversation` 잠금을 가장
  늦게 잡아야 다른 잠금과 순환이 생기지 않는다(`docs/DATABASE.md` "동시성: 잠금과 조건부 쓰기").
- raw SQL에 시각을 넘길 때는 `sqlTimestamp(date)`(`lib/sql.ts`, `'<ISO>'::timestamp(3)`)로 넘긴다. `Date`를 그대로
  넘기면 세션 시간대(로컬 PG는 Asia/Seoul) 때문에 9시간 어긋난다.
