# P0 인프라 검증 1차 (2026-10-21, 12fa770..a72a86d)

검증 워커(Opus)가 구현 워커와 별개로 명세·코드·테스트를 대조하고 서버를 띄워 확인한 결과. 판정: **고친 뒤 P1 시작**. 블로커 없음.

## Findings

**1. should-fix: the proxies do not append the browser IP, so `X-Forwarded-For` can be spoofed.** BEHAVIOR.md rule 10 (lines 131–134) is false as implemented.
- Where: `workbridge-client/src/lib/server/authProxy.js:19-25` (`forwardedFor`), `docs/BEHAVIOR.md:131-134`.
- `forwardedFor()` relies on `request.ip`. In self-hosted Next 14.1.0 that is always `undefined` in route handlers. Next's own `base-server.js:512` does `x-forwarded-for ??= socket.remoteAddress`, which only fills the header when absent. So both proxies pass the client's header through unchanged.
- Evidence (header-echo backend behind `next dev`): no header → `::1`; `X-Forwarded-For: 6.6.6.6` → `6.6.6.6` on both the catch-all and `/api/auth/login`; `6.6.6.6, 7.7.7.7` forwarded as-is. With `TRUST_PROXY=loopback`, `req.ip` becomes the attacker's value.
- Impact: wherever Next is reachable by untrusted clients, rotating the header bypasses the 20/15 min per-IP rule, makes the email+IP failure limit unlimited per account, and lets anyone lock out a chosen IP. Locally no impact.
- Fix: correct rule 10 and PLAN §2.0.3 (proxies forward the header Next received; Next fills it with the socket address only when absent; on Vercel the edge overwrites it). Warn in ENV.md and `.env.example`: `TRUST_PROXY=loopback` is safe only while :3000 is reachable solely by trusted clients. Drop the dead `request.ip` branch. Record the residual risk as a Q.

**2. should-fix: stale-lock recovery has no attempts cap, so a job that kills its runner loops forever.**
- Where: `workbridge-server/src/jobs/runner.ts:163-173` (`recoverStaleJobs`), `:48-64` (claim), `:77-139` (`runOne`).
- Recovery sets `RUNNING`→`PENDING` without checking `attempts >= maxAttempts`, and the claim has no such check. A job whose run dies (OOM, kill, serverless timeout) is recovered and re-claimed every 10 minutes indefinitely.
- `runDueJobs` claims up to 50 and runs them sequentially, so a killed batch strands its tail; those come back with an attempt burned without running. A batch longer than 10 minutes lets a second runner recover and run the tail too; `runOne` checks ownership only on the final update, so handlers can run twice.
- Fix: in `recoverStaleJobs`, set `FAILED` (`lastError: 'stale lock, attempts exhausted'`) when `attempts >= maxAttempts`, else `PENDING`. Add the row to BEHAVIOR's job-state table and a test. Before running each job, re-assert ownership with a conditional `updateMany` (`where: { id, status: 'RUNNING', lockedBy }`) and skip on count 0.

**3. should-fix: locally, every login shares one rate-limit key.**
- Where: `docs/BEHAVIOR.md:133-134`, `.claude/skills/run-workbridge/SKILL.md:57`.
- Browser, Next and drive.sh all connect from loopback; with `trust proxy loopback`, `req.ip` is `::1` for every local login, so the whole machine gets 20 logins per 15 minutes. Rule 10's "locally each browser is counted separately" is wrong. P1+ workers driving flows through run-workbridge/curl can hit 429.
- Fix: correct rule 10 and PLAN §2.0.3. Add `RATE_LIMIT_ENABLED=false` to the run-workbridge `.env` template with a troubleshooting line ("429 on login → `RATE_LIMIT_ENABLED=false` or `DELETE FROM "RateLimitCounter"`"). Note in DECISIONS.

**4. nit: `serializeError` overflows the stack on a cyclic `cause`.** `src/lib/logger.ts:55`. With `e.cause = e` it throws RangeError; inside `errorHandler` the envelope is lost and nothing is logged. Fix: `seen` set or depth cap.

**5. nit: the logger treats any object with a string `message` as an error and drops its other fields.** `src/lib/logger.ts:30-35,82`. `logger.info('n', { notification: {...} })` printed `{"name":"Object","message":"body"}`. `Notification`, `Message`, `ZodIssue` all have `message`. Fix: treat non-`Error` objects as error-like only when they also have a string `stack` (or `name` + `message`). Minor: `stringify` labels a repeated non-circular reference as `"[Circular]"`.

**6. nit: some spec statements have no test, or are inexact.**
- No tests: `startJobWorker`/`cli.ts` loop (ensure-once, recover→run, signal stop); rule 9's "lines logged while a job runs carry its `jobId` and, as `requestId`, that `traceId`" — nothing asserts `runOne` wraps the handler in `runWithContext`.
- Inexact: rule 9 "Error level is reserved" doesn't mention the worker's `error` lines (`src/jobs/worker.ts:36,51`); a job failing inside `POST /api/internal/jobs/run` logs error-level within a 200 request path; the runner's `job failed` line is logged outside the job context.
- Tags: the C table cites `payments.test.ts` for C7, but those tests carry no `[C7]` tag.
- Fix: a small `startJobWorker({ intervalMs: 10, handleSignals: false })` test; a handler-log-context assertion in `jobs.test.ts`; adjust rule 9 wording; add the tags.

**7. nit: one DB error can strand a whole batch for 10 minutes.** `src/jobs/runner.ts:84-87`: `enqueueNextOccurrence` runs outside the `try`; if it throws, `runDueJobs` rejects and every remaining claimed job stays `RUNNING` until recovery. No handler timeout either. Fix: move the enqueue inside the `try` (or catch and warn).

**8. nit: the dev worker stops scheduling after a re-seed.** `src/jobs/worker.ts:47-54`: `ensureRecurringJobs` runs only at worker start; `npm run db:seed` deletes all `Job` rows. Fix: call `ensureRecurringJobs(now)` at the top of every poll (two `ON CONFLICT DO NOTHING` inserts); update the BEHAVIOR runner row.

**9. nit (optional): the concurrency test cannot tell `SKIP LOCKED` from plain `FOR UPDATE`.** `test/jobs.test.ts:234-254`. Fix: hold a row lock in an open transaction and assert `runDueJobs` returns promptly with the other rows claimed.

**10. nit: rate-limit counters only get deleted when a job runner runs.** Production has no runner yet. Bounded growth; note it in the P4 DEPLOYMENT doc.

## Checked and found correct

- All PLAN §2.0 signatures exist in the planned shape (`enqueueJob` inside `$transaction` with `skipDuplicates`, `runDueJobs({now,limit,types,workerId?})`, `ensureRecurringJobs(now, client?)`, registry `ctx = {job,payload,now,logger}`, `notify`/`notifyMany`, `validate` (parsed params → `res.locals.params`), `requireActiveUser`, `createUpload`/`attachmentUpload`/`imageUpload`/`storeUploadedFile`, `serializeError`, `requestContext`/`runWithContext`, `hit/peek/reset`, `rateLimit(rule, {mode})`, `closeExpiredOpenProjects(now)`, `time.ts`, `schemas/common.ts`, `test/helpers/jobs.ts`).
- Claim cannot double-claim; backoff math matches spec; ensure idempotent across workers; `'<ISO>'::timestamp(3)` casts correct (UTC storage verified on an Asia/Seoul session); token compare SHA-256 + `timingSafeEqual`; missing token → plain 404.
- `errorHandler` logs via `console.error` only for 500; the "logs a 500 exactly once" / "nothing for 4xx" tests still meaningful. Lazy sweep intact (rule 7). `it.fails` counts identical per file at both commits (63). No existing controller got zod or `requireActiveUser`.
- Rate-limit tests not a realistic flake risk (file runs in <1 s against a 5 s edge margin). Suite run twice: 1142 passed / 63 expected fail / 1 todo, both times. typecheck, prisma validate, client build (0 errors) and lint (3 pre-existing warnings) all green. PUT proxy probe reached the backend.
- No `.github`/`vercel.json` changes; `import 'dotenv/config'` first; AppError only; no `Promise<void>`; seed.js CommonJS; 6 env vars documented.
- Scope: KST helpers, `schemas/common.ts`, `guardedMutations` skeleton, client `.eslintrc.json` all in scope; nothing to trim.
