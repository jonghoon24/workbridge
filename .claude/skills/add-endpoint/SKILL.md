---
name: add-endpoint
description: workbridge-server에 새 API 엔드포인트(endpoint, route)를 확장 방식으로 추가한다 — BEHAVIOR.md 명세 규칙, zod 스키마, 서비스, 얇은 컨트롤러, 가드를 건 라우트, 권한·소프트 삭제 테스트 표의 행, docs/API.md, 팩토리 기반 테스트. 새 라우트를 만들 때(add a new endpoint) 쓴다. 기존 라우트의 스타일을 바꾸는 데는 쓰지 않는다.
argument-hint: <METHOD> <path> — <하는 일>
---

# 엔드포인트 추가 (확장 방식)

새 라우트는 모두 BEHAVIOR.md 규칙 12를 따른다. 기존 라우트(auth, users, projects,
applications, contracts, payments, reviews, notifications)는 이 방식으로 바꾸지 **않는다**.
기존 컨트롤러가 아니라 최근에 만든 전체 스택 — 알림 설정이나 포트폴리오 라우트 — 을 보고 따라 만든다:

| 레이어 | 예 |
|---|---|
| schema | `src/schemas/profile.ts`, `src/schemas/notificationPreferences.ts`, 헬퍼는 `schemas/common.ts`(`queryInt`, `queryEnum`, `queryString`), `schemas/pagination.ts`(`pageQuery`) |
| service | `src/services/portfolio.service.ts`, `notificationPreferences.service.ts` |
| controller | `src/controllers/settlements.controller.ts` |
| route | `src/routes/settlements.routes.ts`, `profile.routes.ts` |

## 1. 명세 먼저 — `docs/BEHAVIOR.md`

절을 **Notifications 절 뒤에** 추가한다(규칙 12는 그 뒤에 적힌 모든 것에 적용된다). 도메인에 규칙
접두사(`PF`, `NC`, `MS`, …)를 정하고 규칙마다 번호를 매긴다:
- 검사 순서: 역할(403 `Insufficient permissions`) → 업로드(413/400) → 검증(400
  `<path>: <message>`) → 존재(404) → 소유권(403 `Not authorized`) → 상태(409);
- 정확한 메시지, 응답 모양과 상태 코드(`201 { item }`, `200 { items, meta }`);
- 한 트랜잭션에서 바뀌는 행(규칙 6), `notify()`로 보내는 알림, 넣는 작업;
- 소프트 삭제(규칙 5): 삭제된 프로젝트/사용자 때문에 무엇이 안 보이게 되는지;
- 동시성: 트랜잭션이 `lockUserRow`로 시작하는지, 경합하면 결과가 어떻게 되는지.
직접 지어낸 규칙이 있으면 사용자에게 확인을 받는다.

## 2. 스키마 — `src/schemas/<domain>.ts`

- body/query/params마다 `z.object({...})`. 메시지는 명세와 똑같이(`'Title is required'`).
- 금액: 원 단위 정수(`z.number().int()`), 상수는 `lib/money.ts`에서.
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
/** `POST /api/<path>` (XX3). */
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

- 가드는 라우트마다, `router.use`는 쓰지 않는다(Q10). 고정 경로를 `/:id`보다 먼저.
- 새 `/api/users/me/<x>` 라우트는 `profile.routes.ts`에 넣는다(`users.routes.ts` 다음에 마운트된다).
- 새 라우터: `src/index.ts`에서 `errorHandler` 앞에 마운트한다. 기존 마운트 순서는 바꾸지 않는다.

## 6. 매트릭스 (여러 엔드포인트에 걸친 테스트 — 필수)

- `test/authorization.test.ts` → `PROTECTED_ROUTES`에 `RouteSpec`을 추가한다
  (`label`, `method`, `path: (ids) => …`, `body`, `role`, `gate: 'middleware'`). 새 id가 있으면
  `Ids`/`MISSING`에도 추가한다. 표 위 주석의 라우트 개수도 고친다.
- `test/soft-delete.test.ts` → 쓰기 라우트면 **`guardedMutations`**에 `Mutation`을 추가한다
  (`setup()`이 `{ actor, send(token), assertUnchanged() }`를 돌려준다). **`mutations`에는 절대 넣지 않는다**
  (그 표는 기존 라우트용 `it.fails` D12다).
- 401/403/소프트 삭제를 다른 곳에서 엔드포인트마다 다시 단언하지 않는다.

## 7. 엔드포인트 테스트 — `test/<domain>.test.ts`

- 픽스처는 테스트마다 `test/helpers/factories.ts`로, HTTP는 `authed(user)` / `api()`로.
- 라우트마다 `describe` 하나, 테스트 이름에 규칙 번호(`'… [XX3]'`). 검사 순서의 상태 코드마다,
  정확한 메시지, 응답 모양, 실패 시 롤백, 경합이 있으면 경합까지 다룬다.
- 시간: `now`를 넘기고, 작업은 `runJobs(now)` / `jobsOf(type)`로 돌린다. 가짜 타이머 없음.
- 업로드: 파일 맨 위에 `vi.mock('@supabase/supabase-js', …)`.

## 8. 문서

- `docs/API.md`(한국어): 도메인 절 아래에 라우트 — 필드, 응답, 검사 순서대로 오류. 기존 목록 형식에
  맞춘다. 새 도메인이면 "확장 라우트의 공통 순서"에 추가한다.
- 새 모델/컬럼 → `db-migration` 스킬. 새 환경변수 → `src/env.ts`, `.env.example`, `docs/ENV.md`.
- 새 도메인 → `.claude/rules/server-layers.md`, `REVIEW.md`, `docs/ARCHITECTURE.md`의 확장 도메인 목록에 추가한다.

## 9. 검증

```bash
cd workbridge-server
npm run typecheck
npx vitest run test/<domain>.test.ts test/authorization.test.ts test/soft-delete.test.ts
npm test
```

클라이언트가 이 라우트를 부르면: `src/lib/api.js`를 쓰고, `workbridge-client/`에서
`npm run lint && npm run build`를 돌린 뒤 화면을 확인한다(`run-workbridge` 스킬).
