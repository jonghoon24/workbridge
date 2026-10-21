# PLAN.md 검토 1차 (2026-10-21)

검토 워커(Opus)가 PLAN.md를 코드베이스와 대조한 결과. 계획을 쓴 워커와 다른 워커다. 판정: **고친 뒤 실행**.

22개 주장을 코드로 확인했고 아래 5, 6, 9, 13, 18번 외에는 맞았다.

## Findings

**1. blocker — the client proxy has no PUT handler (§2.0.3 l.197; PUT routes at l.517, 530, 815, 946)**
- `workbridge-client/src/app/api/[...path]/route.js:39-53` exports only GET, POST, PATCH and DELETE.
- In the browser, `lib/api.js` `getBaseURL()` returns `''`, so every call goes through this proxy. Each new PUT (milestone plan, payout account, portfolio order, notification preferences) would get a 405 from Next.
- `npm run build` and `npm run lint` pass anyway, and the client has no tests, so nothing would catch it.
- Fix: in P0, when the proxy is edited, add `export async function PUT`. Add a P0 exit check: a curl `-X PUT` through :3000 must reach the backend.

**2. blocker — the new confirm transaction sits inside the existing Toss catch-all (§2.1.4 l.523 with §2.1.2 l.452 "count===0 → 409")**
- In `payments.controller.ts:127-150`, the `try` wraps both the Toss call and the DB write. Its `catch (tossError)` marks the payment `FAILED` and returns 400.
- Put the planned transaction there (payment COMPLETED + conditional milestone PENDING→FUNDED that throws 409 when no row matches), and the D18 race goes: both confirms pass the PENDING check; the loser's milestone update matches 0 rows and throws 409; the catch turns that 409 into "payment FAILED", overwriting the winner's COMPLETED payment while the milestone stays FUNDED.
- The D18 `it.fails` (`payments.test.ts:800`) keeps "passing", so the suite will not notice.
- Separately, any notify/enqueue failure after Toss captured the money also marks the payment FAILED.
- Fix: in the confirm and dev-complete paths, `markFunded` must not throw when 0 rows match; it returns as a no-op (milestone already FUNDED). Add a sentence to the C1 spec stating that a DB failure after capture marks the payment FAILED, as existing behaviour in the D8 family.

**3. should-fix (high) — `Job.dedupeKey @unique` lasts as long as the row (14 days), and two of the plan's keys collide**
- (a) Payouts get stuck (§2.1.2 l.461-465, §2.1.5 l.544). SCHEDULED→ON_HOLD does not increment `payoutAttempts`. `PUT /payout-account` then re-enqueues `settlement.payout:<id>:<attempt>` with the same attempt number as the batch's original job. `skipDuplicates` silently drops it, so the settlement stays SCHEDULED forever. Fix: key the job as `settlement.payout:<id>:<scheduledPayoutAt ISO>`.
- (b) The unread-message digest loses mail and is flaky to test (l.938). The key is `…:<KST hour bucket>`, taken from wall-clock time at the moment the message is POSTed. Lost mail: a message sent after that hour's digest already ran produces no email until someone writes in a later hour. Wrong throttle: messages at 10:59 and 11:00 produce two emails a minute apart. Flaky test across an hour boundary. Fix: throttle inside the handler using `ctx.now`. If there is no unread message, do nothing. If a `MESSAGE_UNREAD_DIGEST` `EmailDelivery` for this (recipient, conversation) exists within the last 60 minutes, re-enqueue for that send time + 60 minutes instead of dropping. Dedupe only against a PENDING job for the same pair.

**4. should-fix — recurring jobs are never created on the only production path (§2.0.2 l.172, 176, 179)**
- `runDueJobs` (and therefore `POST /api/internal/jobs/run`) deliberately skips `ensureRecurringJobs`. So the weekly batch and the lifecycle sweep are never seeded in production, even after an external scheduler is attached. The next occurrence is also enqueued only on success, so one exhausted batch stops the weekly chain until the worker restarts.
- Fix: the internal endpoint calls `ensureRecurringJobs(now)` before `runDueJobs`. Enqueue the next occurrence when a recurring job is claimed (or on any terminal status), not only on success.

**5. should-fix — the per-IP login limit counts the Next server, not the user (§2.0.3 l.197, §2.0.5 l.210)**
- Login does not go through the catch-all proxy. It goes through `app/api/auth/login/route.js` → `lib/server/authProxy.js` `proxyAuthRequest`, which forwards only content-type, authorization and cookie. `TRUST_PROXY` is unset by default, so `req.ip` is 127.0.0.1 for every browser login. The result is "20 logins per 15 minutes for the whole site", which a recorded demo that logs in as several seed accounts will hit.
- Fix: P0 also adds `X-Forwarded-For` / `X-Request-Id` forwarding in `authProxy.js`. Set `TRUST_PROXY=loopback` in `.env.example`. Rule 10 names which IP is the key.

**6. should-fix — new soft-delete rows can't go into the D12 matrix (§1.6 l.98 vs §3.4 l.1018)**
- `mutations` runs under `it.fails.each` (`soft-delete.test.ts:464`). Rows added there that pass, as §3.4 instructs, will fail the suite. `PATCH /api/contracts/:id` → 410 changes nothing and is ≥400, so that existing row also starts passing and breaks.
- Fix: add a separate `guardedMutations` array run with `it.each` for new routes, and move the PATCH row out of `mutations` in P1.

**7. should-fix — seed.js breaks after the P2-S and P3 migrations (§3.2 l.992; P3 3b)**
- FKs are `ON DELETE RESTRICT`, and `seed.js:18-26` deletes `contract` and `user` directly. The `expansion_messaging` backfill inserts Conversation and Participant rows, so the next `db:seed` fails with P2003.
- Fix: every schema commit (P1, P2-S, P3) updates the `deleteMany` list in FK-reverse order.

**8. should-fix — the hand-written backfill SQL will violate NOT NULL (§2.1.1 l.429-435, §2.2.1 l.675)**
- `@default(uuid())` and `@updatedAt` are filled in by the Prisma client, not the database. Migrations create `"id" TEXT NOT NULL` with no default.
- Fix: `INSERT … id = gen_random_uuid()::text, "updatedAt" = now()`. Local PG 14 and CI PG 16 both have `gen_random_uuid()`.

**9. should-fix — the portfolio image upload brings D6 into a new domain (§2.3.2 l.796 vs §2.0.6 l.219)**
- §2.0.6 says new domains will not have D6, but the portfolio uses the existing `upload`, whose file filter throws a plain `Error` (`upload.ts:9-13`) → 500.
- Fix: build an image-only variant on the `attachmentUpload` error wrapper (`image/*`, 5MB, 413/400).

**10. should-fix — attachment storage keys use the original file name (§2.2.2 l.685; milestone files unspecified at l.519)**
- multer 1.4.5-lts.2 builds Busboy without `defParamCharset`, so Korean names arrive garbled in `originalname`. Supabase Storage also rejects non-ASCII object keys (not verified offline). Existing code avoids both with `${id}-${uuid}.${ext}` (`users.controller.ts:66`).
- Fix: the key is `<folder>/<uuid>.<ext>`. Store `Buffer.from(originalname,'latin1').toString('utf8')` in `fileName`. Apply the same rule to `MilestoneAttachment`.

**11. should-fix — settlements return 404 when a project is soft-deleted (§2.1.4 l.533)**
- A `Settlement` groups items from several contracts. A client may soft-delete a project whose contract is COMPLETED. The freelancer's payout record would then 404.
- Fix: exempt settlements and the payout account from this rule; items carry the project title with a `projectDeleted` flag. Specify what the autoApprove and payout handlers do for a deleted project or user.

**12. should-fix — DECISIONS.md and the plan disagree**
- 해결: 오케스트레이터가 DECISIONS.md를 고쳤다. 첨부 파일 공개와 계좌번호 평문은 열린 질문 Q21/Q22로 기록한다. 계획도 Q를 쓴다.

**13. should-fix — stale spec and test items missing from §1.6**
- BEHAVIOR rule 3's example (`PATCH /api/contracts/:id` → 400 for an invalid status on a missing id) and Q15 itself; that route now always returns 410.
- The "Note on validTransitions", which mentions `completeContract`.
- The Notifications "type is one of 4" sentence. It goes stale in P1, which writes 14 new types, not P3.
- `authorization.test.ts:581-582`, which asserts an 8 CLIENT-only / 6 FREELANCER-only split.
- The `Ids`/`MISSING` interface, which needs milestoneId, conversationId and similar fields.
- The internal endpoint is public from P0, so `types/index.ts` "9 public routes" and CLAUDE.md must change in P0, not P2B.
- Fix: add these rows to §1.6.

**14. should-fix — parallel worktrees can't meet exit conditions 3 and 4 (§0 l.25-29, §3.4)**
- `.env` is gitignored, so a new worktree has no `DATABASE_URL`. If workers copy it, they all `migrate dev` and seed the same local `workbridge` database and fight over ports 4000 and 3000.
- Fix: give each worker `.env` with `workbridge_dev_<name>` and its own ports, or run conditions 3 and 4 only on the integration branch after each merge.

**15. should-fix — default milestone amount is ambiguous (l.431 ROUND vs l.483 and l.489 "계약 금액 그대로")**
- `apply` accepts a fractional `expectedRate` (`parseFloat`). The result page sends `parseInt(amount)` and confirm compares with strict `!==`, so a fractional amount can never be paid.
- Fix: the default milestone amount is `Math.round(contract.amount)` everywhere.

**16. should-fix — the logger drops error details (§2.0.3 l.196)**
- `logger.error('unhandled error', { err })` serialized as a JSON line gives `"err":{}`.
- Fix: serialize `name`, `message`, `stack` and `code` explicitly.

**17. nit — the internal-token check can return 500 (l.179)**
- `crypto.timingSafeEqual` throws RangeError when the lengths differ. Fix: compare SHA-256 digests.

**18. nit — wrong account in the seed scenario (§5.1 l.1093, 1098)**
- project8's client is 최민호 / choi@example.com, not 김서준. Fix: use choi in the scenario.

**19. nit — inconsistent `approveMilestone` signature (l.546 vs l.539)**
- Fix: use one signature, with the acting clientId passed in for the ownership check.

**20. nit — the sweep ignores the injected clock**
- `closeExpiredOpenProjects()` uses `new Date()` and ignores `ctx.now`. Fix: state this, or add an optional `now` parameter (additive).

**21. nit — sign and plan-edit edge cases**
- `PUT …/milestones` should start with a conditional `contract.updateMany({where:{id,status:'PENDING'}})` so it takes the row lock and cannot race a second signature.
- Signing with an invalid plan should reject the signature.

**22. nit — undefined boundaries**
- "Same week Wednesday" for `scheduledPayoutAt`: define as periodEnd + 2 days 10:00 KST.
- "오늘(KST) 이후" for `dueDate`: say whether today is allowed.
- The ordering of `Milestone is already funded` (409) vs the old COMPLETED row message. Spec the message.
- The recommendation prefilter's `orderBy` before the 200-row cap.

**23. nit — upload size vs the Vercel body limit**
- 10MB × 5 files exceeds Vercel's 4.5MB request-body limit. Fix: document in DEPLOYMENT.md.

**24. nit — batch transaction timeout**
- Whole weekly batch in one interactive transaction risks Prisma's 5s default timeout. Fix: one transaction per freelancer.

## Parallelization (C)

- Resolved by P2-S: `schema.prisma`, migrations, `TABLES`, factories, `src/index.ts` mounts.
- Unresolved but manually mergeable: `authorization.test.ts` (rows, `Ids`, counts, header comment), `soft-delete.test.ts` (finding 6), `types/index.ts`, BEHAVIOR.md D renumbering (must also rename `it.fails` tags), PROGRESS.md and DECISIONS.md, client `Header.jsx` (P2A edits it; P2B's `/my/recommendations` has no nav entry), `lib/format.js`, `components/ui`, `seed.js` if either worker adds demo data before P4.
- Fix: assign Header edits to p2a-client only and add the recommendations link in P4.
- The merge order (p2b-server → p2a-server → clients) is correct.

## BRIEF compliance, test strategy, size (D, F, G)

- Forbidden items: none found.
- Notification migration: moving all old call sites to `notify()` while keeping their inline strings is a defensible reading of "일부만 옮겨진다".
- Weekly KST settlement calendar: fine. The payout FAILED×3 retry ladder is optional bulk (~300 lines) but fine to keep.
- Test determinism: `now` injection covers auto-approval, batch, retries, stale locks. Exceptions: digest (3b) and sweep (20).
- Size: about 21.8k lines with an 8% margin. P3 client (~400 lines) is thin.

## What the revision must keep

- Spec first in every phase, plus the C1–C10 table and `[Cn]` test tags.
- The serial P2-S schema step.
- The explicit list of affected tests.
- Re-pinning D8, D12, D13, D14, D18 and D21 rather than fixing them.
- Transactional-outbox `enqueueJob` with `skipDuplicates`, and the warning not to catch P2002 inside a transaction.
- `runDueJobs({ now })` instead of fake timers.
- Keeping the lazy sweep alongside the scheduled one.
- Integer money through `lib/money.ts`, with the worked example and the fee-rate snapshot.
- 410 on the old contract PATCH, which keeps the error envelope.
- A logger whose error level stays the single `console.error`.
- Sparse preference storage.
- `requireActiveUser` only on new routes.
- Open decisions that have defaults, so no phase blocks on them.
