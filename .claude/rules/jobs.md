---
paths:
  - "workbridge-server/src/jobs/**/*.ts"
  - "workbridge-server/src/services/**/*.ts"
  - "workbridge-server/src/controllers/internal.controller.ts"
  - "workbridge-server/test/{jobs,auto-approval,settlements,message-digest,email}.test.ts"
---

# Background jobs (`src/jobs/`, Postgres `Job` table)

- Enqueue with `enqueueJob(tx, { type, payload, runAt, dedupeKey })` / `enqueueJobs` **inside the
  transaction of the state change that causes the job** (transactional outbox) — a rolled-back
  change must not leave a job behind (BEHAVIOR.md rule 11).
- Dedupe with `dedupeKey`. It is `createMany({ skipDuplicates: true })`. Never `create` and catch
  P2002 inside an interactive transaction: Postgres aborts the whole transaction on the first
  failed statement, so the caught error still poisons it.
- Handlers are idempotent: re-read state, write conditionally; running twice changes nothing.
- Handlers use `ctx.now`, never `new Date()` (`jobs/types.ts`). Register new types in
  `jobs/registry.ts` and payload types in `jobs/types.ts`; recurring schedules in `jobs/recurring.ts`.
- Job failures are the only non-`errorHandler` `logger.error` lines (rule 9).
- Runners: dev worker started from `index.ts` (`JOB_WORKER_ENABLED`), `npm run jobs:run`, and
  `POST /api/internal/jobs/run` (`X-Internal-Token`, no JWT — never read `req.user` in `runJobs`).
  **Production has no resident worker**: auto-approval, settlements, email and the digest do not
  run there until an external scheduler calls the internal endpoint.
- Tests: `runJobs(now)` / `jobsOf(type)` from `test/helpers/jobs.ts`. When driving a future `now`,
  limit `types` or `project.lifecycleSweep` closes every project whose deadline precedes it.
