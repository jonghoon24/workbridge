---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 서버 레이어 (workbridge-server/src)

## 라우트 만드는 법

- 체인: `authenticate → requireActiveUser → requireRole(...) → validate({ body|query|params }) → controller`.
  이 순서가 모든 라우트의 오류 순서를 인증(401) → 역할(403) → 검증(400) → 서비스의 존재(404) → 소유권(403) →
  상태(409)로 맞춘다. `requireActiveUser`는 탈퇴한 사용자의 아직 만료되지 않은 토큰을 401로 막는다. 어느 라우트에
  붙는지는 `src/middlewares/activeUser.ts` 주석에 있다.
  가드는 **라우트마다** 붙이고 `router.use`는 쓰지 않는다. `router.use`로 걸면 같은 접두사에 나중에 마운트된
  라우터로 가야 할 요청까지 그 가드를 거친다.
- `validate()`는 파싱한 값을 `req.body`, `res.locals.query`, `res.locals.params`에 넣는다(`req.query`가 아니다).
  multipart 라우트(포트폴리오 이미지)에서는 `validate()`를 `imageUpload` **뒤에** 둔다. multer가 본문을 파싱해야
  `req.body`가 채워진다.
- 컨트롤러는 얇게 둔다. 서비스를 부르고 `res.json(...)`으로 답하고, `catch (err) { next(err) }`로 넘긴다.
  비즈니스 로직, 트랜잭션, `AppError`는 `src/services/<domain>.service.ts`에 둔다.
- 환경변수는 `src/env.ts`의 getter로만 읽는다(`process.env` 직접 읽기 금지).
- 파일 첨부는 multipart로 받지 않는다. 서명 업로드 URL과 `uploadIds`(`services/attachments.service.ts`)를 쓴다.
- OpenAPI에 등록한다: 경로와 상태 코드별 응답·오류 코드(`cause(code, '<언제>')`)는 `src/openapi/paths/<domain>.ts`, 응답 모양은
  `src/openapi/responses/<domain>.ts`. 테스트가 모든 응답을 이 문서와 strict하게 대조하므로 문서에 없는 상태 코드나
  필드는 테스트 실패다. 다시 만든 `openapi.json`을 함께 커밋한다.
- 새 라우트는 `test/authorization.test.ts`에 등록한다. `authenticate`가 붙은 라우트는 읽기·쓰기 모두 `PROTECTED_ROUTES`에,
  공개 라우트는 `PUBLIC_ROUTES`에 넣는다. 쓰기 라우트는 `guardedMutations`(`test/soft-delete.test.ts`)에도 넣는다.
  `authorization.test.ts`의 두 표는 앱이 마운트한 라우트와 대조되므로, 거기서 빠뜨리면 테스트가 실패한다.
  전체 단계: `add-endpoint` 스킬.

## 마운트 순서 (`src/index.ts`)

- `/api/users`는 `userRoutes` 다음 `profileRoutes`, `/api/projects`는 `projectRoutes` 다음 `applicationRoutes`다.
  경로가 겹치면(`/me/*`, `/:id`) 먼저 마운트된 라우터가 이긴다. 순서를 바꾸지 않는다.
  새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣는다.
- 라우터 안에서는 고정 경로를 파라미터 경로(`/:id`)보다 먼저 둔다.

## 에러

- `throw new AppError(code, message)`(`lib/errors.ts`)로 던지고 `next(err)`로 넘긴다. 코드는 `lib/errorCodes.ts`의 표에서
  고르고, 상태 코드는 그 표가 정한다. 클라이언트가 같은 안내를 하는 원인이면 기존 코드를 쓰고, 다르게 안내해야 하면 표와
  `test/error-codes.test.ts`의 `PUBLISHED` 끝에 새 코드를 더하고, 클라이언트 `src/lib/errorMessages.js`의 `CODE_MESSAGES`에
  화면 문구를 넣는다(CI의 `check:error-codes`가 대조한다). 기존 코드의 이름·상태를 바꾸거나 지우지 않는다.
- 요청 필드가 틀린 것은 서비스에서도 `invalidField(path, fieldCode, message)`(`VALIDATION_FAILED`)로 던진다.
  컨트롤러에서 `res.status(4xx).json(...)`을 직접 쓰지 않는다.
- 상태 코드: 잘못된 입력은 400, 유니크 충돌은 409, 외부 서비스 실패는 502 또는 400이다. 이런 경우를 500으로
  보내지 않는다. 500은 버그라서 OpenAPI 문서에 넣지 않는다.

## req.user

- non-optional로 타입이 잡혀 있지만 공개 핸들러(`authenticate` 없이 마운트된 핸들러, 목록은
  `src/types/index.ts`의 `Request.user` 주석)에서는 `undefined`다. 컴파일러는 경고하지 않는다. 거기서는 읽지 않는다.
  공개 핸들러를 추가하면 그 주석과 `test/authorization.test.ts`의 `PUBLIC_ROUTES`에 함께 넣는다.

## 트랜잭션과 잠금

잠금 순서와 교착이 생기는 원리는 `docs/DATABASE.md` "동시성: 잠금과 조건부 쓰기"에 있다.

- 행 두 개 이상을 바꾸는 변경은 `prisma.$transaction` 하나로 한다. 알림(`notify()`)과 작업(`enqueueJob()`)도 그
  트랜잭션 클라이언트로 쓴다. 롤백된 변경이 알림이나 작업을 남기면 안 되기 때문이다(`docs/domain/README.md` "원자성").
  기준 예는 `applications.service.ts`의 지원 수락이다.
- 트랜잭션 안팎에서 모두 쓰는 헬퍼는 `PrismaTransactionClient`(`src/types/index.ts`)를 받는다.
- 인터랙티브 트랜잭션 안에서 P2002(유니크 충돌)를 catch하지 않는다. Postgres는 한 문장이 실패하면 트랜잭션 전체를
  중단하므로, catch해도 뒤의 쿼리는 모두 실패한다. 중복을 무시하려면 `createMany({ skipDuplicates: true })`
  (`jobs/queue.ts`)를 쓰고, 409로 바꾸려면 트랜잭션 밖에서 catch한다.
- 지급 계좌, 포트폴리오·경력, 알림 설정을 쓰는 트랜잭션과 주간 정산 배치(`settleFreelancer`)는
  `lockUserRow(tx, userId)`를 첫 문장으로 둔다.
  - 사용자 요청에서는 `lockActiveUserRow`를 쓴다. 잠금을 기다리는 사이 사용자가 탈퇴했으면 401로 끝나서, 탈퇴한
    계정에 데이터를 다시 쓰지 않는다.
  - 정산은 `User`를 잠근 뒤 `Settlement`를 잡는다. 거꾸로 잡으면 지급 결정과 교착한다(#79).
  - 예외: 회원 탈퇴와 지원 생성은 지원 수락과 같은 `Project` → `Application` → `User` 순서로 잠근다.
- 대화방 시스템 메시지(`postSystemMessage`)는 이벤트 트랜잭션의 **마지막 쓰기**로 부른다. `Conversation` 잠금을
  가장 늦게 잡아야 다른 잠금과 순환이 생기지 않는다.
- raw SQL에 시각을 넘길 때는 `sqlTimestamp(date)`(`lib/sql.ts`)를 쓴다. `Date`를 그대로 넘기면 세션 시간대(로컬
  PG는 `Asia/Seoul`)로 해석되어 9시간 어긋난다.
