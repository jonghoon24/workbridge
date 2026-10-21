# P1 검증 1차 (2026-10-21, 29a8a1a..5d1769f)

검증 워커(Opus)가 서버와 클라이언트를 실제로 띄워 전체 흐름을 돌리고, 백필 마이그레이션을 스크래치 DB에서 증명하고, 돈 계산을 재검증한 결과. 판정: **고친 뒤 P2 시작**. 블로커 없음. 클라이언트 가정 13개 중 12개 확인, 1개(Toss 외부 동작)는 검증 불가.

## Findings

**1. should-fix — PA4 reschedule can collide with the original payout's dedupeKey, leaving a SCHEDULED settlement with no payout job (`services/settlements.service.ts:439-450`)**
- `rescheduleHeldSettlements` sets `scheduledPayoutAt = nextKstWeekday(now, WED, 10)`. If that equals the settlement's current `scheduledPayoutAt`, the key `settlement.payout:<id>:<iso>` already exists (SUCCEEDED, from the run that put it ON_HOLD). `enqueueJob` silently no-ops; nothing will ever pay the settlement.
- Evidence: following the run-workbridge skill's "run settlement jobs at a future `now`" recipe (batch + payout at `2026-10-28T02:00Z`, then the freelancer registers an account in the UI): settlement `SCHEDULED | 2026-10-28 01:00:00 | attempts 0`; the only payout job is `SUCCEEDED | …:2026-10-28T01:00:00.000Z`; the PUT still reported `rescheduledCount: 1`.
- With one real clock this can't happen (ON_HOLD is at or after the slot, reschedule strictly after). DECISIONS.md already acknowledges the collision for tests. But the skill's demo path hits it every time, as would clock skew between runner and API.
- Fix: compute the new time strictly after `max(now, settlement.scheduledPayoutAt)`, per settlement. Add to PA4: "strictly after now and after its current `scheduledPayoutAt`".

**2. should-fix — a huge `page` on the new list routes is a 500 that leaks Prisma internals (rule 8, rule 12)**
- `schemas/pagination.ts` with `contracts.service.ts:54` and `settlements.service.ts:332`. `queryInt` accepts any digit string; when `skip = (page−1)×limit` exceeds int64, Prisma throws.
- Evidence: `GET /api/contracts?page=999999999999999999` → 500 with `Invalid prisma.contract.findMany() invocation … Unable to fit value 20000000000000000000 into a 64-bit signed integer for field skip`. Same on `/api/settlements`.
- Fix: give `page` a `max` (e.g. 1,000,000) or check `Number.isSafeInteger(page*limit)` → 400. Fix in `pageQuery` since P2 reuses it.

**3. nit — Korean particle wrong in notification templates (`lib/notifications/templates.ts`)**
- `` `마일스톤 ${ms(v)}이 …` `` always uses 이: "마일스톤 '개발과 배포'이 승인되었습니다". Affected: MILESTONE_APPROVED, MILESTONE_AUTO_APPROVED, MILESTONE_AUTO_APPROVE_REMINDER. Fix: rephrase to avoid a particle after the title, e.g. "'X' 마일스톤이 승인되었습니다". Visible in any recorded demo.

**4. nit — MS7 "first failing field" order depends on zod phase**
- Due-date checks (past, decreasing) run in `superRefine`, only after every item passes base checks. `[{#0 dueDate yesterday}, {#1 title " "}]` returns `milestones.1.title: Title is required`, not `milestones.0.dueDate`. Fix: move the past-date check into `planItem`, or state in MS7 that date-order checks come after per-item checks.

**5. nit — raw English server errors on the payout-account page**
- "Account holder must match your name" and the 409 `Payout account cannot be changed while a payout is processing` are shown verbatim. Consistent with existing pages, but these two are predictable; a Korean mapping like the plan editor's would match.

**6. nit — `MILESTONE_AUTO_APPROVE_DAYS` is missing from `docs/ENV.md`**; `env.ts` doc comment points to `milestoneAutoApproveDays()`, which doesn't exist (it's `autoApproveDays`).

**7. nit — MS2 shape: attachments also carry `submissionId`.** Spec lists six keys. Select those keys or amend MS2.

**8. nit — test tagging and coverage gaps**
- No test tagged `[CT4]`, `[CT10]`, `[MS2]`, `[MS3]`, `[MS4]`, `[MS9]`, `[PY12]`, `[S17]`, `[M21]`. MS9 tagged only on its `describe`; PY12 tested without a tag.
- S17/PA7 has no race test; only sequential 409s. An in-process probe (20 races of `runPayout` vs `deletePayoutAccount`, slow provider) produced only valid outcomes.

**9. nit — dead code and duplication**
- `pageQuerySchema` and `PageQuery` (`schemas/pagination.ts`) unused.
- Client: `MAX_PAYOUT_ATTEMPTS = 3` defined twice (`SettlementStatusBadge.jsx`, `settlements/[id]/page.jsx`). `MILESTONE_STATUS_LABELS`/`SETTLEMENT_STATUS_LABELS` live in component files while other labels live in `constants/milestones.js`.

**10. nit — client UI wording and layout**
- `/my/payments` shows "마일스톤 2회차"; "회차" collides with submission rounds ("1차 제출"). Use "2번째 마일스톤" or "#2".
- `SubmissionForm` per-link "삭제" button wraps to two lines; `whitespace-nowrap`/`shrink-0`.

**11. nit (reasoned, not reproduced) — concurrent `/dev-complete` on a milestone with no payment row is a 500** (both `tx.payment.create` on unique `milestoneId` → P2002 inside the tx). Same class as D13, dev-only route. Not in the spec.

**12. housekeeping** — the server agent's upload stub on :54321 was still running (orchestrator killed it).

## Client assumptions (13)

| # | Result | Evidence |
|---|---|---|
| 1 | Confirmed | `GET /api/milestones/:id` returns `contract = {id,status,amount,clientId,freelancerId,project:{id,title}}`. |
| 2 | Confirmed | `GET /api/contracts/:id` keys include `projectId,applicationId,clientId,freelancerId,amount,…,project,client{…},freelancer,milestones,reviews,milestoneSummary`; no `payment` key. |
| 3 | Confirmed | UI save → `PUT …/milestones 200` then `GET /api/contracts/:id 200`. |
| 4 | Confirmed | Approve response `{milestone, contract:{id,status:"COMPLETED",completedAt}}`; UI alert fired. |
| 5 | Confirmed | `milestones.0.amount: Amount must be at least 10000` etc.; editor rewrites; others raw. |
| 6 | Confirmed | 11 MB PDF → `413 {"error":{"message":"File too large (max 10MB)"}}`. |
| 7 | Confirmed | Repeated `links` accepted; single-string `links` becomes a one-element list. |
| 8 | Confirmed (code) | `confirmPayment` reads only `{paymentKey, orderId, amount}`. |
| 9 | Not verifiable | Toss external; matches Toss v1 docs. |
| 10 | Confirmed | `feeRateBps: 1000` renders "10%". |
| 11 | Confirmed (code) | S11 sets `scheduledPayoutAt = now+24h` on retryable FAILED; summary buckets under `scheduled`. |
| 12 | Confirmed | `400 Account holder must match your name`; "박 지윤" matched "박지윤". |
| 13 | Confirmed | `GET /api/settlements?page=1&limit=20`, `GET /api/contracts?page=1&limit=10`. |

## Command outputs
- Server suite ×2: `Test Files 28 passed (28) · Tests 1465 passed | 61 expected fail | 1 todo (1527)`, 50.6 s / 57.0 s. No flakes; slowest file `authorization.test.ts` 9.7 s (459 tests).
- `it.fails` 63 → 61: only D12 PATCH row and D21 "cannot be completed" removed; D13/D14 re-pinned on `milestoneId`.
- typecheck clean; prisma validate valid; client build OK (9 new/changed routes); lint 3 pre-existing warnings.
- Migration proven on a scratch DB with 9 legacy contracts: 2,500,000.5 → 2,500,001; 0.5 → 1; FAILED payment amount realigned; ACTIVE+COMPLETED payment → FUNDED; COMPLETED contract → APPROVED/MANUAL; COMPLETED with no payment → APPROVED null `fundedAt`; REFUNDED → PENDING milestone. Constraints added after backfill. `migrate diff` reports no drift.
- Money: all worked examples exact; two items of 15,005 → fee 3,000 (not 3,001); 200k random grosses fee+VAT+net = gross; live contract 3,000,000.5 → `contractAmount` 3,000,001, settlement totals = item sums with `feeRateBps` 1000 snapshot.

## Checked and found correct
- All concurrency rules present in code as written (MS9 pre-image FOR UPDATE; MS16/MS20 contract lock first, AUTO requires `autoApproveAt <= now`, fresh completion count; MS13/MS19 status write first; PY8 conditional FAILED; PY7 no-op markFunded; S17/PA7 User lock; S4/J6 period from dedupeKey; S5 createMany skipDuplicates; S9 transfers its own netAmount).
- Every exercised message/status in PY1, PY5, PY10, MS7, MS12, MS15, MS18, PA3, CT7 matched the spec.
- Full UI flow end to end; all notification hrefs open working pages; no console errors beyond the expected 400.
- BRIEF compliance: no CI/external changes; Float/String[] kept; lazy sweep still writes; no zod on `POST /api/payments`; zod/requireActiveUser only on new routes; `deletedAt` filters on every new User/Project path with the S2 exemption; seed CommonJS, deleteMany order correct; dotenv first. No P2/P3 leakage.
