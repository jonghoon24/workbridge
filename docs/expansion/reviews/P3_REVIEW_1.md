# P3 검증 1차 (2026-10-21, bc1d263..5242573, HEAD 59d0a9b)

검증 워커(Opus)가 명세 대조, 실패 주입(Job INSERT 거부 트리거), 브라우저 흐름, 전체 테스트 두 번을 돌린 결과. 판정: **P4 시작 가능**. 블로커 없음. 2014 통과 / 62 핀 / 1 todo ×2 (아래 1번의 중복 행 때문에 실제는 2013).

## Findings

**1. should-fix (merge artifact): `guardedMutations` has 18 rows, not 17 — the DELETE-message row is duplicated.** `test/soft-delete.test.ts:789` duplicates `:656`. The P2 fix 0712092 moved `DELETE /api/conversations/:id/messages/:messageId` into the "Phase 2A" group; P3's branch still had it at the end next to the PUT row; the merge kept both. Fix: delete the trailing DELETE block (788–801); put the PUT row under `// Phase 3 — notification preferences (NC7).`; set PROGRESS.md to 2013; add a label-uniqueness check on `guardedMutations` like `PROTECTED_ROUTES` has.

**2. nit: NC13 has no tagged test, and the link-base rule is neither tested nor documented.** `templates.ts` `linkBase()` uses the first comma-separated entry of `CLIENT_URL`, trims trailing `/`, defaults to `http://localhost:3000`. Fix: one `[NC13]` test with `CLIENT_URL='http://a.test/, http://b.test'` asserting the body contains `http://a.test/my/notifications/settings`; add "쉼표 목록이면 첫 항목" to ENV.md.

**3. nit: one 2A race assertion was loosened beyond the five allowed Job-table edits.** `test/message-read.test.ts:355`: `job.count() === 1` became `digestsFor(freelancer.id)` length 1, and nothing asserts the email side. Fix: also assert `emailDelivery.count({ where: { type: 'MESSAGE_UNREAD_DIGEST' } }) <= 1`; if 1, the participant's `lastReadAt` is at or after the delivery's `createdAt`.

**4. nit: the `soft-delete.test.ts` header comment (~l.519) names Phases 1 and 3 but not Phase 2.**

## Assumptions: all 13 confirmed (2 is confirmed in code but untested/undocumented → finding 2; 9's top-level null/string body is rejected by `express.json` strict mode first — pre-existing).

## Checked and found correct
- NC2 `policy.ts` matches all 20 rows (category, recipient, defaults, locks); CLIENT 8 / FREELANCER 17. NC3 single `effectiveChannels` used by notify/GET/PUT. NC4 `normalizeStored`. NC6 two passes, locked own-value no-op. NC7 raw `FOR UPDATE` first, no upsert. NC9 signatures as pinned; every call site inside its caller's tx (4 legacy sites with inline wording, sign, milestones, settlements, digest); J3–J5 wrapped; `ctx.now` threaded J2–J7; Q11 in-app row kept with no email. J9 order and `status='PENDING'` conditional writes; SKIPPED for soft-deleted; unsupported provider → FAILED, attempts unchanged, `PermanentJobError`; no error-level logging in the handler. NC16 throttle in any status via the index; re-enqueue checks PENDING; no loop/drop with 2A's re-check.
- Merge: nothing from 0712092 lost. PROTECTED 63, header arithmetic correct.
- Live: GET 17/8 in NC2 order; GET→PUT round-trip byte-identical; 15 NC6 messages exact; 12 concurrent PUTs consistent; settings page groups/locks/"이메일 전체 끄기"/persist/390px/no extra polling; MILESTONE_FUNDED email on → one job → `mail.sent`; off → no job, in-app kept; digest `notified` → SENT with `contextKey`, 0 in-app rows; `throttled` at +25 with `nextRunAt` = last + 60; at +71 `notified`. Failure injection: Job INSERT rejected → 500, milestone PENDING, Notification/EmailDelivery/Payment/Job counts unchanged; after dropping the trigger the same call succeeded.
- Suite ×2 identical, no flakes, max 3 s. typecheck/validate/build clean; lint 3 pre-existing + 1 eslint-disable. `it.fails` 62. Removed test lines limited to the allowed edits plus finding 3. `[C7]` intact; only new log above info is the NC14 `warn`.
- BRIEF/CLAUDE.md: env vars in env.ts/ENV.md/.env.example/skill; CLAUDE.md one non-inferable bullet; per-route guards; zod on new route only; dotenv first; Prisma types; legacy wording inline; no external service/CI change. `enqueueJobs` consistent with `enqueueJob`; no dead `due`; templates not asserted by wording.
