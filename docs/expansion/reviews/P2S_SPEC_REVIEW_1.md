# P2-S 명세 검토 1차 (2026-10-21, c3f5584)

검토 워커(Opus)가 명세·스키마·마이그레이션·시드를 코드와 대조하고 스크래치 DB에서 실행한 결과. 판정: **고친 뒤 구현**. 블로커 없음. 병합 트리 테스트 1474 통과 / 62 핀 / 1 todo.

## Findings

**1. should-fix — J8: the enqueue rule can send a digest about a message that is only seconds old, so J8's stated outcome is false.** (J8, MG15)
- The enqueue is skipped whenever a PENDING job exists for the pair, and that job fires at the first message's time + 10 min. Message A at t0 → job at t0+10. Recipient reads at t0+2. Message B at t0+9; no job enqueued. At t0+10 the job sees B unread and (P3) emails about a 1-minute-old message. J8 promises "a message read within 10 minutes never causes an email".
- Fix (2A step 2): after the zero-unread check, if the oldest unread counterpart message has `createdAt > ctx.now − 10 min`, enqueue a new job at `that createdAt + 10 min` (unless a PENDING one exists) and end SUCCEEDED. The running job is RUNNING, so the PENDING check does not see itself.

**2. should-fix — PF8 contradicts PF11/PF12: a reorder racing a delete can 500.**
- PF8 says "a reorder never interleaves with a create or delete" and "deletes take no lock". The reorder reads under the User lock; a concurrent DELETE commits; `tx.portfolioItem.update` on the deleted id throws P2025 inside the tx → 500 (rule 8).
- Fix: `DELETE /me/portfolio/:itemId` takes the same User-row lock first.

**3. should-fix — MG6/MG7 do not say what happens when the contract has no conversation.**
- `makeContract` creates no conversation; only `makeContractScenario` does. `payments.test.ts` `extraActiveContract` (l.68) feeds the D22 `it.fails` dev-complete race; if posting throws on a missing conversation, every dev-complete there 500s and D22 "fails" for the wrong reason.
- Fix: MG7: "a contract without a conversation posts nothing (warn log)".

**4. should-fix (handoff) — the two new routers must attach guards per route, never with `router.use`.**
- `profile.routes.ts` is mounted on `/api/users` after `userRoutes`; both Q10 vectors live there (`GET /api/users`, `DELETE /api/users/me`, `authorization.test.ts:1517-1530`) and the two public GETs (PF16/PF17). Same for `conversations.routes.ts`. P1 made this call for settlements but neither router comment nor DECISIONS says it.
- Fix: one line in both router comments and DECISIONS.

**5. should-fix (handoff) — files both workers would plausibly touch, not in the ownership split.**

| File | Rule |
|---|---|
| `src/schemas/common.ts`, `src/schemas/pagination.ts` | Read-only. Each worker's limits/cursor/month helpers go in its own `schemas/<domain>.ts`. |
| `src/lib/time.ts` | 2B only (PF2 KST month helpers). |
| `test/helpers/factories.ts`, `test/helpers/api.ts` | Read-only. Local helpers live in each test file. |
| `test/lib.test.ts` | 2B only. 2A puts pure-function tests in its own files. |

The rest of the split holds: no 2A endpoint in a 2B file or the reverse (MG18 in `contracts.routes.ts` = 2A; RC3 in `projects.routes.ts` = 2B); neither needs schema/`db.ts`/`index.ts`; client Header.jsx and `middleware.js` (`/messages`) are 2A only; `/my/recommendations` already covered by `/my`; page sets do not overlap; `lib/notifications/templates.ts` 2A at most.

**6. nit — the lock order in MG7 omits Project.** No cycle found today (every P1 flow traced). Fix: add "system messages are the last writes of their event transaction (CONTRACT_COMPLETED after MILESTONE_APPROVED)".

**7. nit — RC6 and RC7 compare categories differently.** RC6 prefilter matches `category = activityCategory` untrimmed; RC7 scores on trimmed equality. Fix: both use exact stored values, or categories come from the fixed taxonomy.

**8. nit — authorization counts in the handoff are imprecise.** The test asserts 11 public routes (10 handlers) today; after 2B it is 13 routes / 12 handlers. Expected deltas: PROTECTED 43 → 61 (2A +8, 2B +10); ROLE_GATED 24 → 33 (2B +9); CLIENT/FREELANCER 11/13 → 12/21; public 11 → 13.

**9. nit — stale lines.** "Suggested test priority" item 2 says "six coupled writes" (now seven); "Background jobs" intro omits the digest; the "Payloads:" paragraph omits `message.unreadDigest` (`{ conversationId, recipientId }`); PLAN §2.2.1/§2.3.1/§3.2 (two migrations), §2.4.3/§2.4.6 (P3 adds the digest enqueue), §2.2.2 (watermark = last message) are superseded by DECISIONS — point the P3 worker at DECISIONS.

**10. nit — `Message.sender` `onDelete: Restrict` is undocumented.** Deliberate and correct (default SetNull would turn a TEXT message into a sender-less pseudo-system message). Say so in the schema comment or DATABASE.md in P4.

## Checked and found correct
- Worked examples: RC4 = 69.17; RC7 = 66.96 (freshness continuous at 7 and 30 days); PF6 26 months = 2y 2m; PF2 `2025-03` → `2025-02-28T15:00Z`; PF21 weights sum to 100.
- Recommendations deterministic (score → reviewCount/deadline → id); prefilter `orderBy` concrete and before the 200 cut; soft-deleted/non-OPEN/past-deadline/already-applied excluded; reuses `normalizeSkill`/`expandSkillSearchTerms`; ≤200 candidates with O(1) batched queries.
- MG7 `FOR UPDATE` re-read gives strictly increasing `createdAt` in commit order; cursor and watermark sound. MG8 unread count consistent across list/detail/mark-read/unread-count/MG19/J8. MG9/MG15 agree. MG6 covers every P1 event.
- No P2002 inside transactions. J8 split implementable in 2A with no dangling type.
- Every response object has scalar fields enumerated. Migration DDL byte-identical to `migrate diff`; backfill verified on a scratch DB with TZ Asia/Seoul. Seed twice OK. `TABLES` complete; `makeContractScenario` returns `conversation`; `makeMessage` moves `lastMessageAt` forward only.
- No existing test breaks. 150 rule IDs unique; D1–D22 unchanged; only Q21 new; 19 notification rows; section order per PLAN §4.1; mount order works.
