---
paths:
  - "workbridge-server/test/**/*.ts"
  - "workbridge-server/vitest.config.ts"
---

# 서버 테스트 (vitest + supertest)

- 실패한 테스트를 통과시키려고 단언을 지우거나 약하게 바꾸지 않는다. 동작을 바꾸는 것이 요청받은 변경일 때만 테스트를 고친다.
- 기존 코드에 테스트를 붙이다가 버그로 보이는 동작을 만나면 그 동작을 단언으로 고정하지 않고 보고한다.
- 버그를 `it.fails`·`it.skip`·`it.todo`로 남기지 않는다. 버그는 GitHub 이슈로 추적하고, 고치는 PR이 고치기 전 코드에서
  실패하는 회귀 테스트를 넣는다.
- 테스트 이름은 동작을 서술하는 영어 문장이다. 규칙 ID나 이슈 번호 태그를 붙이지 않는다.
- `api()`·`authed()`로 받은 모든 응답은 `test/helpers/openapi.ts`가 OpenAPI 응답 스키마(객체는 strict)로 검사한다.
  새 상태 코드나 응답 필드는 테스트보다 먼저 `src/openapi/paths/<domain>.ts`·`responses/<domain>.ts`에 적는다.
  문서에 없는 것이 나오면 테스트를 우회하지 말고 문서나 코드를 고친다.
- **실제 Postgres를 쓰고 Prisma를 모킹하지 않는다.** 스위트가 FK, 유니크 제약, 롤백을 검사한다.
  병렬로 돌리는 실행은 `bash scripts/test-db.sh <name>`으로 각자 DB를 만들어 `TEST_DATABASE_URL`로 가리킨다 —
  테스트마다 모든 테이블을 비우므로 DB를 같이 쓰면 서로의 픽스처를 지운다.
- 픽스처는 테스트마다 `test/helpers/factories.ts`로 만든다. HTTP는 `test/helpers/api.ts`(`api()`, `authed(user)`).
- 시간은 `now`를 넘겨 제어한다(서비스에는 `now`, 작업은 `test/helpers/jobs.ts`의 `runJobs(now)`).
  **가짜 타이머는 쓰지 않는다**(Prisma와 섞이지 않는다).
- **여러 엔드포인트에 걸친 관심사는 한 곳에서 한 번만 테스트한다 — 엔드포인트마다 다시 단언하지 않는다:**
  - 401/403/소유권: `test/authorization.test.ts`의 `PROTECTED_ROUTES` / `PUBLIC_ROUTES`.
  - 소프트 삭제된 호출자: `test/soft-delete.test.ts`의 `guardedMutations`(`requireActiveUser`가 붙은 쓰기 라우트 전부).
- 업로드하는 테스트 파일은 **맨 위에** `vi.mock('@supabase/supabase-js', …)`를 둔다(`uploads.test.ts` 참고). 첨부(비공개
  버킷)는 `helpers/storageFake.ts`와 `helpers/attachments.ts`의 `uploadFiles()`를 쓴다(`attachments.test.ts` 참고).
- `test/setup.ts`는 앱(`helpers/api`)을 import하지 않는다. import하면 모든 `vi.mock`이 너무 늦게 등록된다.
- `vitest.config.ts`의 `LOG_LEVEL: 'error'`를 유지한다(500의 error 로그를 `console.error` 스파이로 단언한다).
