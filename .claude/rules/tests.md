---
paths:
  - "workbridge-server/test/**/*.ts"
  - "workbridge-server/vitest.config.ts"
  - "docs/BEHAVIOR.md"
---

# Server tests (vitest + supertest)

- **`docs/BEHAVIOR.md` is the oracle.** Assert the intended behavior, cite the rule id in the test
  name (`… [PF8]`, `… [D3]`). Never weaken an assertion to match current code.
- **Known divergences are pinned with `it.fails`** and tagged with the D id (`[D12]`) or
  `[unlisted]`. An `it.fails` passing = the bug was fixed → flip it to `it` *in the same change as
  the fix* and move the BEHAVIOR.md row to "Resolved" (`fix-divergence` skill). Never flip a pin
  without a fix, never add `it.fails` to hide a new failure.
- **Real Postgres, no Prisma mocks.** The suite checks FKs, unique constraints and rollback.
  `bash scripts/test-db.sh` creates/migrates `workbridge_test`; `TEST_DATABASE_URL` overrides.
  `resetDb()` TRUNCATEs every table before each test and `assertTestDatabase()` refuses a URL
  without "test". Files run serially (`fileParallelism: false`) — don't share a DB between runs.
- Build fixtures per test with `test/helpers/factories.ts` (`makeClient`, `makeFreelancer`,
  `makeProject`, `makeContractScenario`, `makeMilestone`, …). No shared fixtures, no order coupling.
- HTTP via `test/helpers/api.ts`: `api()`, `authed(user)`, `tokenFor(user)`, `expiredToken`.
- Jobs and time: `runJobs(now)` / `jobsOf(type)` / `atDaysFromNow` from `test/helpers/jobs.ts`.
  **Never fake timers** (they don't mix with Prisma). Pass `now` to services.
- **Cross-cutting concerns are tested once, centrally — don't re-assert per endpoint:**
  - 401/403/ownership: `PROTECTED_ROUTES` / `PUBLIC_ROUTES` in `test/authorization.test.ts`.
  - soft delete: `test/soft-delete.test.ts` — `mutations` (old routes, `it.fails` D12) and
    `guardedMutations` (expansion routes, plain `it`). **Never add an expansion route to `mutations`.**
- Uploads: `vi.mock('@supabase/supabase-js', …)` at the **top of each test file** that uploads
  (see `uploads.test.ts`). `test/setup.ts` must never import the app (`helpers/api`), or every
  `vi.mock` registers too late.
- Error logging: a 500 is logged exactly once (`console.error` spy); keep `LOG_LEVEL: 'error'`.
- No test may reach a real external service (axios/OpenAI are mocked in the files that need it).
- Run one file: `npx vitest run test/<file>.test.ts`; whole suite `npm test` (~90 s).
  `npm run typecheck` also covers `test/`.
