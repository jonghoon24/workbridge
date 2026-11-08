---
paths:
  - "workbridge-server/test/**/*.ts"
  - "workbridge-server/vitest.config.ts"
  - "docs/BEHAVIOR.md"
---

# 서버 테스트 (vitest + supertest)

- **`docs/BEHAVIOR.md`가 오라클이다.** 의도한 동작을 단언하고, 테스트 이름에 규칙 번호를 적는다
  (`… [PF8]`, `… [D3]`). 지금 코드에 맞추려고 단언을 약하게 바꾸지 않는다.
- **알려진 불일치는 `it.fails`로 고정**하고 D 번호(`[D12]`)나 `[unlisted]` 태그를 단다.
  `it.fails`가 통과한다 = 버그가 고쳐졌다 → *그 수정과 같은 변경에서* `it`으로 뒤집고 BEHAVIOR.md의
  행을 "Resolved"로 옮긴다(`fix-divergence` 스킬). 수정 없이 핀을 뒤집지 않고, 새 실패를 숨기려고
  `it.fails`를 추가하지 않는다.
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
  - 소프트 삭제: `test/soft-delete.test.ts` — `mutations`(기존 라우트, `it.fails` D12)와
    `guardedMutations`(확장 라우트, 그냥 `it`). **확장 라우트를 `mutations`에 넣지 않는다.**
- 업로드: 업로드하는 테스트 파일마다 **맨 위에** `vi.mock('@supabase/supabase-js', …)`를 둔다
  (`uploads.test.ts` 참고). `test/setup.ts`는 앱(`helpers/api`)을 import하지 않는다. import하면
  모든 `vi.mock`이 너무 늦게 등록된다.
- 에러 로그: 500은 정확히 한 번 로그된다(`console.error` 스파이). `LOG_LEVEL: 'error'`를 유지한다.
- 어떤 테스트도 실제 외부 서비스에 닿지 않는다(axios/OpenAI는 필요한 파일에서 모킹한다).
- 파일 하나: `npx vitest run test/<file>.test.ts`, 전체 스위트: `npm test`(~90초).
  `npm run typecheck`는 `test/`도 검사한다.
