# P3-S 명세 검토 1차 (2026-10-21, 63b7e98 + 657d8c9)

검토 워커(Opus)가 명세·스키마를 코드와 대조한 결과. 판정: **고친 뒤 구현**. 블로커 없음. worktree에서 1474 통과 / 62 핀 / 1 todo.

오케스트레이터 결정: 4번은 첫 번째 안(다이제스트는 잠긴 off 채널: GET `inApp: false`, PUT은 `false`를 no-op으로 받고 `true`는 400). 8번은 부팅 시 `warn` 한 줄(throw 없음).

## Findings

**1. should-fix: five existing assertions will break, and nothing in the spec or hand-off names them.** (NC9, C9)
- Under NC2 defaults, `MILESTONE_SUBMITTED` and `MILESTONE_FUNDED` send email; NC9 enqueues a `notification.email` job in the same transaction. These tests assert the entire `Job` table: `test/milestones.test.ts:174`, `:231`, `:310`; `test/payments.test.ts:932`, `:955`. Both files belong to 2A during P2, so this is also a merge point.
- Fix: list these in DECISIONS "P3-S" as P3 test edits, filtering by `type: { not: 'notification.email' }` or asserting with `jobsOf()`.

**2. should-fix: the J3–J5 notices call `notify` with no transaction.** (NC9, rule 6)
- `sendMilestoneNotice` (`src/services/milestones.service.ts:662-673`) calls `notifyTemplate(prisma, …)` with the base client. In P3 it becomes three writes per recipient; a partial failure + J5 retry duplicates in-app rows.
- Fix: NC9: "a caller without a transaction opens one"; name `sendMilestoneNotice` as the call site to wrap in `prisma.$transaction`.

**3. should-fix: the `notify()` signature and return value are not pinned.** (NC9)
- Today returns `Promise<Notification>`; `test/notify.test.ts:13-21` asserts on it. Under NC2/NC3 the in-app row can be absent. Also open: where `now` goes; what `notifyMany`/`notifyRecipients` return; that `notifyRecipients`, `notifyTemplate`, `notifyFreelancer` and the J2/J6/J7 paths must thread `ctx.now`.
- Fix: `notify(client, input, now = new Date()): Promise<Notification | null>`; `notifyMany` returns the number of in-app rows; `notifyRecipients` takes `now`. Note: `createManyAndReturn` (Prisma 5.22) to get `notificationId`s.

**4. should-fix: the digest's `inApp` cannot round-trip from GET to PUT.** (NC5, NC6 rule 2.3)
- GET returns `inApp: null, inAppLocked: true` for `MESSAGE_UNREAD_DIGEST`; echoing back fails the shape check, and `inApp: true` fails rule 3. A client that saves by posting GET's array back fails on that entry.
- Fix (decided): make the digest a locked-off channel: GET `inApp: false`, PUT accepts `inApp: false` as a no-op and rejects `true`.

**5. should-fix (merge): P3-S edits BEHAVIOR.md in place, next to text 2A/2B may also edit.**
- Overlaps: rule 5 bullet after the Conversations/PF20 bullet; rule 6 sentence after "Phase 2 adds"; job-type row under `message.unreadDigest`; the re-wrapped `message.unreadDigest` Payloads line; the J8 appended line + J9 right after (2A implements J8); the NC section right after RC's `---` (2B); C9 adjacent to C10 (2B); Q24/Q25 after Q23. Also `templates.ts`, `jobs/types.ts`, `jobs/registry.ts` are 2A-only in P2 — P3 server work starts after the 2A merge.
- Fix: add these to the merge notes; reduce the J8 overlap per finding 7.

**6. nit: a delivery can stay `PENDING` forever.** (NC12, J9) — stale-lock recovery with attempts exhausted; DB error at step 4 on the last attempt; the SENT write failing on the last attempt. Fix: acknowledge in NC12 ("its job's FAILED row is then the record") or in Q24.

**7. nit: duplicated normative text.** J8 steps 3–4 and NC16 both specify the throttle; J8 step 3 lacks "in any status"; J8 and the job-type table hard-code "60 min" while NC1/NC16 defer to MG1. MG20 still says "the notification types stay the 19". Fix: cut J8 steps 3–4 to "see NC16"; MG20 → "in-app types".

**8. nit: an unsupported `MAIL_PROVIDER` fails every send permanently and silently.** (NC14) Fix (decided): one-time boot `warn` for an unsupported value (no throw). State what `provider` holds in that FAILED case.

**9. nit: P3 test-matrix deltas are not written down.** PROTECTED 61 → 63 (GET/PUT preferences); ROLE_GATED unchanged; `guardedMutations` +1 (PUT). `docs/ENV.md` and `src/env.ts` need `MAIL_PROVIDER`, `MAIL_FROM`. Q24/Q25 assume 2A/2B add no Q.

## Checked and found correct
- NC2 policy matches PLAN §2.4.2; counts CLIENT 3+5=8, FREELANCER 12+5=17, total 20. NC3 is the single rule used by notify/GET/PUT. NC6 zod ordering matches. NC7 User lock creates no cycle. Throttle/re-check paths always schedule strictly after now; no loop, no dropped digest; digest creates no in-app row; `ctx.now` as createdAt keeps the throttle deterministic. Runner logging matches rule 9. Q11 pin stays true. No external account. Migration matches schema; throttle index covers the lookup; SetNull never triggered; String `type` needs no migration; seed order and TABLES fine. Factories diff append-only. 167 unique IDs; section order per §4.1; 19-row table unchanged; routes don't shadow `/:id/read`.
