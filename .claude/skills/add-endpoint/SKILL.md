---
name: add-endpoint
description: workbridge-server에 새 API 엔드포인트(endpoint, route)를 추가한다 — 동작 정하기, zod 스키마, 서비스, 얇은 컨트롤러, 가드를 건 라우트, OpenAPI 경로·응답 스키마 등록과 openapi.json 재생성, 권한·소프트 삭제 테스트 표의 행, 팩토리 기반 테스트. 새 라우트를 만들 때(add a new endpoint) 쓴다.
argument-hint: <METHOD> <path> — <하는 일>
---

# 엔드포인트 추가

새 라우트는 모두 이 방식(가드 체인, zod 검증, 서비스 레이어)으로 만든다. 최근에 만든 전체 스택 — 알림 설정이나
포트폴리오 라우트 — 을 보고 따라 만든다.
서버 파일을 열면 `.claude/rules/`의 서버 규칙(레이어, 트랜잭션·잠금, 금액·시간, 알림·로그, 작업)이 함께 들어온다.
아래 단계는 그 규칙을 다시 적지 않고 순서와 손댈 곳만 적는다.

| 레이어 | 예 |
|---|---|
| schema | `src/schemas/profile.ts`, `src/schemas/notificationPreferences.ts`, 헬퍼는 `schemas/common.ts`(`queryInt`, `queryEnum`, `queryString`), `schemas/pagination.ts`(`pageQuery`) |
| service | `src/services/portfolio.service.ts`, `notificationPreferences.service.ts` |
| controller | `src/controllers/settlements.controller.ts` |
| route | `src/routes/settlements.routes.ts`, `profile.routes.ts` |
| OpenAPI | `src/openapi/paths/settlements.ts`, `src/openapi/responses/settlements.ts`, 헬퍼는 `src/openapi/common.ts` |

## 1. 동작 먼저 정하기

코드를 쓰기 전에 다음을 정한다:
- 검사 순서: 역할(403 `FORBIDDEN_ROLE`) → 업로드(413/400) → 검증(400 `VALIDATION_FAILED`, `<path>: <message>`)
  → 존재(404 `<RESOURCE>_NOT_FOUND`) → 소유권(403 `FORBIDDEN_RESOURCE`) → 상태(409);
- 원인마다 오류 코드(`src/lib/errorCodes.ts`)와 메시지. 클라이언트가 같은 안내를 하는 원인이면 기존 코드를 쓰고, 아니면
  새 코드를 표와 `test/error-codes.test.ts`의 `PUBLISHED` 끝에 더한다(이름 규칙은 표의 주석). 응답 모양과 상태 코드
  (`201 { item }`, `200 { items, meta }`)와 함께 6단계에서 OpenAPI에 그대로 적는다;
- 한 트랜잭션에서 바뀌는 행, `notify()`로 보내는 알림, 넣는 작업(`docs/domain/README.md` "원자성");
- 소프트 삭제: 삭제된 프로젝트/사용자 때문에 무엇이 안 보이게 되는지(`docs/domain/README.md` "소프트 삭제");
- 동시성: 트랜잭션이 `lockUserRow`로 시작하는지, 경합하면 결과가 어떻게 되는지.

엔드포인트가 제품 결정(누가 무엇을 할 수 있는지, 상태 전이, 정책)을 담고 있으면 그 결정과 이유를 `docs/domain/`의 해당
문서에 적는다. 동작 서술, 한도 값, 요청·응답 모양과 오류 문장은 옮겨 적지 않는다(코드와 OpenAPI가 원본이다).
직접 지어낸 규칙이 있으면 사용자에게 확인을 받는다.

## 2. 스키마 — `src/schemas/<domain>.ts`

- `z`는 `src/lib/zod.ts`에서 import한다(`.openapi()`가 붙어 있어 이 스키마가 그대로 문서의 요청 스키마가 된다).
- body/query/params마다 `z.object({...})`. 메시지는 1단계에서 정한 문장 그대로(`'Title is required'`).
- 금액은 `bodyWholeWon(label, { min })`, 날짜는 `YYYY-MM-DD` / `YYYY-MM` 문자열로 받는다.
- 서비스가 쓸 추론 타입을 export한다(`export type XInput = z.infer<typeof xBody>`).

## 3. 서비스 — `src/services/<domain>.service.ts`

- 모든 로직과 모든 `throw new AppError(code, message)`는 여기에 둔다(상태 코드는 코드가 정한다). 저장된 값과 비교해야 하는
  필드 검사는 `invalidField(path, fieldCode, message)`로 던진다. 시간에 따라 달라지면 `now: Date`를 받는다.
- 1단계에서 정한 트랜잭션 경계, 잠금, 알림, 작업을 그대로 옮긴다.
- 읽기는 `User`/`Project`(그리고 `contract.project`를 거치는 경우도)에 `deletedAt: null`을 건다.

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

파싱된 query는 `res.locals.query`, params는 `res.locals.params`에 있다. 공개 핸들러면 `src/types/index.ts`의
목록과 `test/authorization.test.ts`의 `PUBLIC_ROUTES`에 추가한다.

## 5. 라우트

```ts
const guard = [authenticate, requireActiveUser, requireRole('FREELANCER')];
router.post('/things', ...guard, validate({ body: thingBody }), postThing);
// multipart(이미지): ...guard, imageUpload, validate({ body }), handler
// 파일 첨부는 multipart로 받지 않는다: 서명 업로드 URL + uploadIds(services/attachments.service.ts)
```

- 새 라우터: `src/index.ts`에서 `errorHandler` 앞에 마운트한다. 기존 마운트 순서는 바꾸지 않는다.

## 6. OpenAPI 등록 — `src/openapi/`

- 응답 모양: `src/openapi/responses/<domain>.ts`에 zod 스키마로(공통 조각은 `responses/common.ts`). 실제 응답의
  필드를 빠짐없이 적는다 — 테스트가 응답을 strict하게 검사하므로 빠진 필드는 실패다.
- 경로: `src/openapi/paths/<domain>.ts`에 `registry.registerPath({...})`. `request`에는 2단계의 스키마를 그대로
  넣고, `responses`에는 성공 응답(`ok`/`created`)과 1단계의 오류를 원인마다 적는다(`errors(invalid(…),
  ACTIVE_USER, role(…), cause('<RESOURCE>_NOT_FOUND', '<언제>'), NOT_OWNER, cause('<CODE>', '<언제>'))`). 상태 코드는
  코드가 정하고, 경로마다 적은 코드만 응답 스키마에 들어가므로 빠진 원인은 그 응답을 받는 테스트가 실패한다. 500은 적지 않는다.
- 새 도메인 파일이면 `src/openapi/registry.ts`의 `buildRegistry()`에 등록 함수를 추가한다.
- 다시 만든 `openapi.json`을 함께 커밋한다(CI가 최신인지 검사한다). 로컬 서버의 `GET /api/docs`에서 화면으로
  확인할 수 있다.

## 7. 매트릭스 (여러 엔드포인트에 걸친 테스트 — 필수)

- `test/authorization.test.ts` → `PROTECTED_ROUTES`에 `RouteSpec`을 추가한다
  (`label`, `method`, `path: (ids) => …`, `body`, `role`). 새 id가 있으면
  `Ids`/`MISSING`에도 추가한다.
- `test/soft-delete.test.ts` → 쓰기 라우트면 **`guardedMutations`**에 `Mutation`을 추가한다
  (`setup()`이 `{ actor, send(token), assertUnchanged() }`를 돌려준다).
- 401/403/소프트 삭제를 다른 곳에서 엔드포인트마다 다시 단언하지 않는다.

## 8. 엔드포인트 테스트 — `test/<domain>.test.ts`

- 라우트마다 `describe` 하나. 검사 순서의 상태 코드마다, 정확한 메시지, 응답 모양, 실패 시 롤백, 경합이 있으면
  경합까지 다룬다. 1단계에서 정한 동작을 단언한다 — 구현이 다르게 나오면 단언이 아니라 구현을 고친다.

## 9. 문서

- 제품 결정과 그 이유 → `docs/domain/`(1단계). API 모양은 6단계의 OpenAPI가 문서다.
- 새 모델/컬럼 → `db-migration` 스킬. 새 환경변수 → `src/env.ts`, `.env.example`, `docs/ENV.md`.

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
