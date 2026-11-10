---
paths:
  - "workbridge-server/test/**/*.ts"
  - "workbridge-server/vitest.config.ts"
  - "docs/domain/**"
---

# 서버 테스트 (vitest + supertest)

- **테스트는 지금 코드가 아니라 의도한 동작을 단언한다.** 근거는 `docs/domain/`(제품 규칙), OpenAPI 문서
  (상태 코드와 응답 모양), 이슈에서 내린 결정이다. 테스트가 실패한다고 단언을 지금 응답에 맞춰 약하게 바꾸지
  않는다. 의도가 바뀐 것이면 근거 문서를 같은 변경에서 고친다.
- **알려진 버그를 `it.fails`·`it.skip`·`it.todo`로 고정하지 않는다.** 버그는 GitHub 이슈로 추적하고(도메인
  문서의 `현재 다름: #N`), 고치는 PR이 회귀 테스트를 추가한다. 회귀 테스트는 고치기 전 코드에서 실패해야 한다.
  이유: 실패를 기대하는 테스트는 스위트 안에 "틀린 기대"를 쌓아 무엇이 의도인지 읽기 어렵게 하고, 버그 목록이
  테스트와 이슈 두 곳으로 갈라진다.
- 테스트 이름은 동작을 서술하는 영어 문장이다. 규칙 ID나 이슈 번호 태그를 붙이지 않는다.
- **응답 적합성 검사.** `api()`·`authed()`로 받은 모든 응답을 `test/helpers/openapi.ts`가 OpenAPI 응답
  스키마(객체는 strict)로 검사한다. 문서에 없는 상태 코드나 필드가 나오면 그 요청을 보낸 테스트가 실패한다.
  새 상태 코드나 응답 필드를 만들면 테스트보다 먼저 `src/openapi/paths/<domain>.ts`·`responses/<domain>.ts`를
  고치고 `npm run openapi`. 500은 문서에 넣지 않는다(오류 봉투만 검사한다). 라우트를 더하거나 빼면
  `test/openapi.test.ts`가 앱의 라우트와 문서의 경로를 양방향으로 대조한다.
- **실제 Postgres를 쓰고 Prisma를 모킹하지 않는다.** 스위트가 FK, 유니크 제약, 롤백을 검사한다.
  `bash scripts/test-db.sh`가 `workbridge_test`를 만들고 마이그레이션한다. `TEST_DATABASE_URL`로 바꿀 수 있다.
  `resetDb()`가 테스트마다 모든 테이블을 TRUNCATE하고, `assertTestDatabase()`는 "test"가 없는 URL을
  거부한다. 파일은 순서대로 돈다(`fileParallelism: false`) — 실행끼리 DB를 같이 쓰지 않는다.
- 픽스처는 테스트마다 `test/helpers/factories.ts`로 만든다(`makeClient`, `makeFreelancer`,
  `makeProject`, `makeContractScenario`, `makeMilestone`, …). 공유 픽스처도, 순서 의존도 없다.
- HTTP는 `test/helpers/api.ts`: `api()`, `authed(user)`, `tokenFor(user)`, `expiredToken`.
- 작업과 시간: `test/helpers/jobs.ts`의 `runJobs(now)` / `jobsOf(type)` / `atDaysFromNow`.
  **가짜 타이머는 절대 쓰지 않는다**(Prisma와 섞이지 않는다). 서비스에는 `now`를 넘긴다.
- **여러 엔드포인트에 걸친 관심사는 한 곳에서 한 번만 테스트한다 — 엔드포인트마다 다시 단언하지 않는다:**
  - 401/403/소유권: `test/authorization.test.ts`의 `PROTECTED_ROUTES` / `PUBLIC_ROUTES`.
  - 소프트 삭제된 호출자: `test/soft-delete.test.ts`의 `guardedMutations`(`requireActiveUser`가 붙은 쓰기
    라우트). 기존 라우트는 아직 이 가드가 없어(#7) 넣으면 실패한다. #7을 고치는 PR에서 함께 넣는다.
- 업로드: 업로드하는 테스트 파일마다 **맨 위에** `vi.mock('@supabase/supabase-js', …)`를 둔다
  (`uploads.test.ts` 참고). 첨부(비공개 버킷)는 메모리 저장소 `helpers/storageFake.ts`와
  `helpers/attachments.ts`의 `uploadFiles()`(업로드 URL 발급 → 브라우저의 PUT 흉내)를 쓴다(`attachments.test.ts` 참고). `test/setup.ts`는 앱(`helpers/api`)을 import하지 않는다. import하면
  모든 `vi.mock`이 너무 늦게 등록된다.
- 에러 로그: 500은 정확히 한 번 로그된다(`console.error` 스파이). `LOG_LEVEL: 'error'`를 유지한다.
- 어떤 테스트도 실제 외부 서비스에 닿지 않는다(axios/OpenAI는 필요한 파일에서 모킹한다).
- 파일 하나: `npx vitest run test/<file>.test.ts`, 전체 스위트: `npm test`(~90초).
  `npm run typecheck`는 `test/`도 검사한다.
