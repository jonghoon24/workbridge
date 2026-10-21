# P1 명세 검토 1차 (2026-10-21, 1c560e1)

검토 워커(Opus)가 명세를 쓴 워커와 별개로 BEHAVIOR.md의 P1 절을 코드·기존 테스트와 대조한 결과. 판정: **고친 뒤 구현**. 돈 계산, 달력 예시, 규칙 ID 위생, 상태 기계는 맞았다. 문제는 주로 동시성이다.

5번의 선택은 오케스트레이터가 (a)로 정했다(DECISIONS.md "P1 (명세 검토 반영)").

## Findings

### 1. [blocker] MS16/MS17: approving the last two milestones at the same time leaves the contract `ACTIVE` with nothing to fix it
- MS17 completes the contract when the approval "leaves every milestone APPROVED". Under READ COMMITTED, two approval transactions on different milestones each make their own conditional milestone write, then count non-APPROVED milestones and still see the other as `SUBMITTED` (uncommitted). Neither completes the contract.
- Result: every milestone `APPROVED`, contract `ACTIVE` forever, no `CONTRACT_COMPLETED`, reviews impossible, `PATCH` is 410 (CT11) so nothing can repair it. MS21 only covers a race on one milestone.
- Fix: add to MS16/MS20: "The approval transaction's first statement locks the contract row (`SELECT … FROM "Contract" WHERE id = $1 FOR UPDATE`, raw). The completion check runs after the milestone write, on a fresh statement." Add an MS21b test: two different milestones approved concurrently → contract `COMPLETED`, exactly one `CONTRACT_COMPLETED` per party.

### 2. [should-fix] MS13: two submissions at once can return a 500 (P2002 inside the transaction) instead of a 409
- MS13 creates the submission (round = previous highest + 1) before the status write. Two concurrent submissions both compute round 1; the second INSERT fails with P2002 inside the tx → 500. Breaks the P0 rule against P2002 inside a transaction and MS13's own "409 of step 3".
- Fix: the conditional `FUNDED|REVISION_REQUESTED → SUBMITTED` write is the transaction's first statement (as MS9), and the round is computed after it. Say so explicitly for MS13, MS16, MS19.

### 3. [should-fix] M7/M9: the migration backfill's `ROUND` disagrees with `Math.round` for amounts ending in .5
- `Contract.amount` is float8; Postgres `round(float8)` rounds ties to even, JS `Math.round` rounds half up. Verified: `round(2500000.5::float8)` = 2500000 vs `Math.round` = 2500001. `applications.test.ts:422` posts `expectedRate: '2500000.5'`.
- Result: a backfilled plan sums to N while M7 says N+1 → a PENDING contract fails CT7, contradicting "the API cannot produce an invalid plan".
- Fix: migration note in M9/M7: backfill uses `ROUND(amount::numeric)` (or `FLOOR(amount + 0.5)`), matching `Math.round` for positive values. Correct PLAN §2.1.1 step 2.
- Related nit: `expectedRate` ≤ 0.5 passes `apply` (`> 0`) but rounds to 0; milestone of 0 can never be paid (confirm's `!amount` guard). Decide: require M7 ≥ 1 or say accepted.

### 4. [should-fix] PY7–PY9: the no-op funding step only prevents the COMPLETED→FAILED overwrite in the test mock
- Real TossPayments rejects the second confirm of the same `paymentKey`; the loser enters the catch-all whose `payment.update({ where: { orderId }, data: { status: 'FAILED' } })` is unconditional. The winner's COMPLETED can end FAILED while the milestone stays FUNDED.
- Fix: PY8: "the FAILED write is conditional on the payment still being `PENDING` (`updateMany where { orderId, status: 'PENDING' }`)". Extend PY9's test with a variant where the second provider call rejects. Reword "holds today" to "must hold".

### 5. [should-fix] Soft-deleted project: escrowed money is frozen, contradicting MS20 and S2
- D11 still allows deleting a project whose contract is ACTIVE. Then every milestone route is 404 and J2 no-ops, so a SUBMITTED/FUNDED milestone whose money was captured can never be approved. MS17's "a soft-deleted project is never written" clause is dead.
- **Orchestrator decision: (a).** J2 approves regardless of project deletion. MS17 skips the project write and the notifications for the deleted context. Manual approval stays 404.
- Same area: `POST /api/payments/confirm` on a deleted project is unspecified (rule 5 lists only `POST /` and `/dev-complete`). **Orchestrator decision:** confirm is 404 before capture, same as dev-complete.

### 6. [should-fix] MS8 + MS9: "signature was present before the call" cannot be read the way MS9 requires
- MS9's first statement is a conditional `updateMany` (returns a count, not previous flags). MS8's `MILESTONE_PLAN_UPDATED` needs the pre-image; an implementer will read flags outside the tx, and a signature landing in between is silently wiped with no notification.
- Fix: allow the first statement to be `SELECT "clientSigned","freelancerSigned","status" FROM "Contract" WHERE id=$1 FOR UPDATE` (raw), then the conditional update; the notification uses the locked pre-image.

### 7. [should-fix] S4/J6 and the job-type table: two formulas for the batch period, and retries change `runAt`
- S4/J6 say "the KST Monday 00:00 of its `runAt`"; the job-type table says `periodStart = runAt − 7 days − 3 h`. They agree only when `runAt` is exactly Monday 03:00. A retry rewrites `runAt` to `now + backoff` (`runner.ts:142`); recurring jobs carry no payload (`recurring.ts:44`), so the slot is recoverable only from `dedupeKey`. A late catch-up batch with one failing freelancer retries into a different week, contradicting S4 and S6.
- Fix: J6 derives the period from the slot in `job.dedupeKey` (or P1 adds payload support to `RecurringJob`). Never from the current `runAt`. Define once: `periodEnd` = the slot's Monday 00:00 KST. State that a late batch's `scheduledPayoutAt` may be in the past → payout runs immediately.

### 8. [should-fix] PA3/PA5 vs S9: "PROCESSING locks the account" is check-then-act with no serialization
- PA5 checks for a PROCESSING settlement then deletes; S9 reads the account, snapshots, moves to PROCESSING. A delete/change can commit right after S9's read.
- Fix: S9 reads the account `FOR UPDATE` inside its transaction. PA3/PA5 do their write first (locks the row), then check for PROCESSING in the same transaction and roll back with 409 if one exists.

### 9. [should-fix] An existing test breaks and neither the spec nor PLAN §1.6 mentions it
- `authorization.test.ts:1362` uses `GET /api/contracts` as its Q10 "mounted router, no index route" vector (HTML 404 `Cannot GET /api/contracts`). CT1 makes it real → 401.
- Fix: name a replacement unmatched vector in PLAN §1.6, e.g. `GET /api/payments/nope`.
- The other collisions are all accounted for in PLAN §1.6 (D12 PATCH row removed, D21 completeContract row moved, PATCH 404/403 rows → 410, C7 logging 409 vector changes, D13/D14/D18 re-pinned on `milestoneId`).

### 10. [should-fix] Gaps the client screens will hit
- No `payoutPreview` source for backfilled approvals: MS11 says it is "the settlement item's stored values", but S3/PLAN do not backfill settlement items. Specify a fallback: M3 at the current rate, or `null`.
- `/contracts/[id]` has no per-milestone preview: MS1 milestone objects (CT5, MS6) lack `payoutPreview`; the page would need N calls. Add `payoutPreview` to MS1 or change the client plan.
- No whole-won contract amount for the plan editor's "합계 일치" check: CT5/MS10 return the raw possibly-fractional `amount`. Add e.g. `milestoneSummary.contractAmount` (M7).

### 11. [nit] PY1 vs PY10: the same states give different errors, and dev-complete can leave a milestone unfunded
- "REFUNDED + earlier milestone pending" is 400 on `POST /` but 409 on dev-complete. "milestone PENDING but payment COMPLETED" is 409 on `POST /` but 200 on dev-complete, leaving the milestone PENDING forever. PY11 doesn't say an in-place completion resets `amount` to the milestone amount (today's code writes `contract.amount`).
- Fix: move PY10 steps 8–9 before 6–7, or have step 6 also run PY7; state the amount.

### 12. [nit] J2: auto-approval's conditional write guards only on status
- If a reject and a resubmission commit between J2's read and its write, the round-1 job approves round 2 at once. Fix: the AUTO write also requires `autoApproveAt <= now`, or matches the latest round.

### 13. [nit] S5 vs S9: adding items to a SCHEDULED settlement can race the payout
- Fix: S5's totals update is conditional on `status = SCHEDULED` and in the same tx as linking the items; S9 transfers the `netAmount` returned by its own conditional transition. Prisma `upsert` on the compound key `(freelancerId, periodStart)` is find-then-insert, so prescribe `createMany({ skipDuplicates })` followed by a read.

### 14. [nit] Wording and realism
- CT3: what `counterpart` shows when the counterpart is soft-deleted (Q11 territory).
- After acceptance, `endDate` is the recruitment deadline, which can be earlier than the only milestone's due date. Deliberate per DECISIONS but looks wrong in the UI.
- `MILESTONE_OVERDUE` fires immediately when a milestone is funded after its due date; M16 only exempts the due-soon notice. Say so if intended.
- M22 says retries are "24 hours apart", which no longer holds after ON_HOLD → reschedule.

## Checked and found correct
- M3 worked examples (1,234,567 → 123,456 / 12,345 / 1,098,766; 9.5M; 10,000; 15,005; two items of 15,005 → item sums 3,000/300/26,710 vs total-recomputed fee 3,001). Calendar examples M12, M9, M19/M20, dedupe-key example, M23 masking.
- Constants stated once and referenced consistently. Settlement and milestone state machines complete; S15 buckets partition every settlement. Job no-op detection by status and round; payout key includes `scheduledPayoutAt` ISO. No-op `markFunded` consistent with PY8. MS9 serialization holds apart from finding 6. Re-pinned D rows (D8, D12, D13, D14, D18, D21) still fail as intended. Rule 3/Q15 example correct.
- 96 identifiers unique; every reference resolves; C1–C9 defined; D/Q numbers unchanged; Q22 added, Q21 free; 19 notification types; section order matches PLAN §4.1; nothing from P2/P3 leaked. `jobs.test.ts` uses `RECURRING_JOBS.length`.
- Not verified: whether Prisma native upsert applies to `PayoutAccount.userId` under concurrent PUTs.
