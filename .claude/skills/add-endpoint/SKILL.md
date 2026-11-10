---
name: add-endpoint
description: workbridge-server에 새 API 엔드포인트(endpoint, route)를 확장 방식으로 추가한다 — 동작과 도메인 규칙(docs/domain), zod 스키마, 서비스, 얇은 컨트롤러, 가드를 건 라우트, OpenAPI 경로·응답 스키마 등록과 openapi.json 재생성, 권한·소프트 삭제 테스트 표의 행, 팩토리 기반 테스트. 새 라우트를 만들 때(add a new endpoint) 쓴다. 기존 라우트의 스타일을 바꾸는 데는 쓰지 않는다.
argument-hint: <METHOD> <path> — <하는 일>
---

# 엔드포인트 추가 (확장 방식)

새 라우트는 모두 이 방식(가드 체인, zod 검증, 서비스 레이어)으로 만든다. 기존 라우트(auth, users, projects,
applications, contracts, payments, reviews, notifications)는 이 작업에서 바꾸지 **않는다**(이전은 #40).
기존 컨트롤러가 아니라 최근에 만든 전체 스택 — 알림 설정이나 포트폴리오 라우트 — 을 보고 따라 만든다:

| 레이어 | 예 |
|---|---|
| schema | `src/schemas/profile.ts`, `src/schemas/notificationPreferences.ts`, 헬퍼는 `schemas/common.ts`(`queryInt`, `queryEnum`, `queryString`), `schemas/pagination.ts`(`pageQuery`) |
| service | `src/services/portfolio.service.ts`, `notificationPreferences.service.ts` |
| controller | `src/controllers/settlements.controller.ts` |
| route | `src/routes/settlements.routes.ts`, `profile.routes.ts` |
| OpenAPI | `src/openapi/paths/settlements.ts`, `src/openapi/responses/settlements.ts`, 헬퍼는 `src/openapi/common.ts` |

## 1. 동작 먼저 정하기 — 도메인 규칙은 `docs/domain/`

코드를 쓰기 전에 다음을 정한다:
- 검사 순서: 역할(403 `Insufficient permissions`) → 업로드(413/400) → 검증(400
  `<path>: <message>`) → 존재(404) → 소유권(403 `Not authorized`) → 상태(409);
- 정확한 메시지, 응답 모양과 상태 코드(`201 { item }`, `200 { items, meta }`) — 6단계에서 OpenAPI에 그대로 적는다;
- 한 트랜잭션에서 바뀌는 행, `notify()`로 보내는 알림, 넣는 작업(`docs/domain/README.md` "원자성");
- 소프트 삭제: 삭제된 프로젝트/사용자 때문에 무엇이 안 보이게 되는지(`docs/domain/README.md` "소프트 삭제");
- 동시성: 트랜잭션이 `lockUserRow`로 시작하는지, 경합하면 결과가 어떻게 되는지.

새 제품 규칙(정책 수치, 상태 전이, 권한, 그 이유)이 생기면 `docs/domain/`의 해당 문서에 적는다. 요청·응답 모양과
오류 문장은 도메인 문서에 옮겨 적지 않는다(OpenAPI가 맡는다). 직접 지어낸 규칙이 있으면 사용자에게 확인을 받는다.

## 2. 스키마 — `src/schemas/<domain>.ts`

- `z`는 `src/lib/zod.ts`에서 import한다(`.openapi()`가 붙어 있어 이 스키마가 그대로 문서의 요청 스키마가 된다).
- body/query/params마다 `z.object({...})`. 메시지는 1단계에서 정한 문장 그대로(`'Title is required'`).
- 금액: 원 단위 정수(`src/schemas/common.ts`의 `bodyWholeWon(label, { min })`), 상수는 `lib/money.ts`에서.
- 날짜: `YYYY-MM-DD` / `YYYY-MM` 문자열을 검증하고 `lib/time.ts` 헬퍼로 비교한다.
- 서비스가 쓸 추론 타입을 export한다(`export type XInput = z.infer<typeof xBody>`).

## 3. 서비스 — `src/services/<domain>.service.ts`

- 모든 로직과 모든 `throw new AppError(message, status)`는 여기에 둔다.
- 시간에 따라 달라지는 것이 있으면 `now: Date`를 매개변수로 받는다. 여기서 `new Date()`를 부르지 않는다.
- 여러 행 쓰기: `prisma.$transaction(async (tx) => …)` 하나.
  - 사용자별 쓰기(지급 계좌, 포트폴리오/경력, 알림 설정): **첫** 문장으로 `await lockUserRow(tx, userId)`.
  - 알림: 트랜잭션 안에서 `notify(tx, {...})` / `notifyMany(tx, …)`.
  - 작업: 트랜잭션 안에서 `enqueueJob(tx, { type, payload, runAt, dedupeKey })`.
  - 유니크 충돌 → 409: P2002는 트랜잭션 **밖에서** catch하거나 `skipDuplicates`를 쓴다.
- 읽기는 `User`/`Project`(그리고 `contract.project`를 거치는 경우도)에 `deletedAt: null`을 건다.
- 로그는 `logger`(`warn`/`info`)로만.

## 4. 컨트롤러 — `src/controllers/<domain>.controller.ts`

```ts
/** `POST /api/<path>` — <하는 일>. */
export async function postThing(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await createThing(req.user.id, req.body as ThingInput, new Date()));
  } catch (err) {
    next(err);
  }
}
```

파싱된 query는 `res.locals.query`, params는 `res.locals.params`에 있다(`req.query`가 아니다).
`Promise<void>`를 붙이지 않는다. 공개 핸들러는 `req.user`를 읽지 않는다. 그런 핸들러는
`src/types/index.ts`의 목록과 `test/authorization.test.ts`의 `PUBLIC_ROUTES`에 추가한다.

## 5. 라우트

```ts
const guard = [authenticate, requireActiveUser, requireRole('FREELANCER')];
router.post('/things', ...guard, validate({ body: thingBody }), postThing);
// multipart: ...guard, attachmentUpload /* or imageUpload */, validate({ body }), handler
```

- 가드는 라우트마다, `router.use`는 쓰지 않는다(같은 접두사의 다음 라우터로 갈 요청까지 가로챈다). 고정 경로를 `/:id`보다 먼저.
- 새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣는다(`users.routes.ts` 다음에 마운트된다).
- 새 라우터: `src/index.ts`에서 `errorHandler` 앞에 마운트한다. 기존 마운트 순서는 바꾸지 않는다.

## 6. OpenAPI 등록 — `src/openapi/`

- 응답 모양: `src/openapi/responses/<domain>.ts`에 zod 스키마로(공통 조각은 `responses/common.ts`). 실제 응답의
  필드를 빠짐없이 적는다 — 테스트가 응답을 strict하게 검사하므로 빠진 필드는 실패다.
- 경로: `src/openapi/paths/<domain>.ts`에 `registry.registerPath({...})`. `request`에는 2단계의 스키마를 그대로
  넣고, `responses`에는 성공 응답(`ok`/`created`)과 1단계의 오류를 상태 코드별로 적는다(`errors(invalid(…),
  ACTIVE_USER, role(…), notFound(…), NOT_OWNER, {409: [...]})`). 500은 적지 않는다.
- 새 도메인 파일이면 `src/openapi/registry.ts`의 `buildRegistry()`에 등록 함수를 추가한다.
- `npm run openapi`로 `openapi.json`을 다시 만들고 함께 커밋한다(CI가 최신인지 검사한다). 로컬 서버의
  `GET /api/docs`에서 화면으로 확인할 수 있다.

## 7. 매트릭스 (여러 엔드포인트에 걸친 테스트 — 필수)

- `test/authorization.test.ts` → `PROTECTED_ROUTES`에 `RouteSpec`을 추가한다
  (`label`, `method`, `path: (ids) => …`, `body`, `role`, `gate: 'middleware'`). 새 id가 있으면
  `Ids`/`MISSING`에도 추가한다. 표 위 주석의 라우트 개수도 고친다.
- `test/soft-delete.test.ts` → 쓰기 라우트면 **`guardedMutations`**에 `Mutation`을 추가한다
  (`setup()`이 `{ actor, send(token), assertUnchanged() }`를 돌려준다).
- 401/403/소프트 삭제를 다른 곳에서 엔드포인트마다 다시 단언하지 않는다.

## 8. 엔드포인트 테스트 — `test/<domain>.test.ts`

- 픽스처는 테스트마다 `test/helpers/factories.ts`로, HTTP는 `authed(user)` / `api()`로. 이 두 헬퍼가 받은 응답을
  모두 6단계의 문서와 대조한다(`test/helpers/openapi.ts`). 문서에 없는 상태 코드나 필드가 나오면 테스트가 아니라
  문서나 코드를 고친다.
- 라우트마다 `describe` 하나, 테스트 이름은 동작을 서술하는 영어 문장(규칙 ID 태그 없음). 검사 순서의 상태
  코드마다, 정확한 메시지, 응답 모양, 실패 시 롤백, 경합이 있으면 경합까지 다룬다. 1단계에서 정한 의도를
  단언한다 — 구현이 다르게 나오면 단언이 아니라 구현을 고친다.
- 시간: `now`를 넘기고, 작업은 `runJobs(now)` / `jobsOf(type)`로 돌린다. 가짜 타이머 없음.
- 업로드: 파일 맨 위에 `vi.mock('@supabase/supabase-js', …)`.

## 9. 문서

- 새 제품 규칙 → `docs/domain/`(1단계). API 모양은 6단계의 OpenAPI가 문서다.
- 새 모델/컬럼 → `db-migration` 스킬. 새 환경변수 → `src/env.ts`, `.env.example`, `docs/ENV.md`.
- 새 도메인 → `.claude/rules/server-layers.md`, `docs/ARCHITECTURE.md`의 확장 도메인 목록에 추가한다.

## 10. 검증

```bash
cd workbridge-server
npm run typecheck
npm run lint
npm run openapi && git diff --stat openapi.json   # 바뀐 경로만 늘었는지 본다
npx vitest run test/<domain>.test.ts test/authorization.test.ts test/soft-delete.test.ts test/openapi.test.ts
npm test
```

클라이언트가 이 라우트를 부르면: `src/lib/api.js`를 쓰고, `workbridge-client/`에서
`npm run lint && npm run build`를 돌린 뒤 화면을 확인한다(`run-workbridge` 스킬).
