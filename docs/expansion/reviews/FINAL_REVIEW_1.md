# 최종 검증 1차 (2026-10-21, HEAD 2877404)

검증 워커(Opus)가 새 클론에서 문서만 보고 설치·시드·실행·테스트하고, PLAN §5.3 시나리오 전체와 브라우저 전 도메인 흐름, 명세 샘플 28개, 문서↔코드 대조, CI 조건(UTC, `.env` 없음) 재현까지 돌린 결과. 판정: **고친 뒤 준비 완료**. 블로커 없음. 2015 통과 / 62 핀 / 1 todo (로컬과 UTC 모두). UI 흐름 677 요청 중 4xx/5xx 0건.

## Findings

**1. should-fix: CLAUDE.md leaves out the rules an agent cannot work out from the code** (PLAN §5.2 items 1, 3, 5, 6, 10). `grep -c` returns 0 for `zod`, `requireActiveUser`, `money`, `KST`, `runDueJobs`, `skipDuplicates`, `enqueue`, `/api/users`, `jobs.ts`.
- Missing: service layer / zod / `requireActiveUser` / attachment-upload middleware exist only in the new domains and older controllers must not be refactored (the deliberately kept debt); job-queue rules (enqueue inside the state change's transaction; `skipDuplicates` not catching P2002; tests drive the queue with `runDueJobs({ now })`, never fake timers; dev worker starts in `index.ts`, production has no worker); all money through `lib/money.ts`, dates on a fixed KST (+9) offset; `/api/users` mounted twice (users, then profile) and the order matters; test helpers `helpers/jobs.ts` and the Supabase mock pattern.
- Stale: "strict `routes → controllers → lib` flow" (`src/services/` exists); the `lib/` list names 3 files (now 20+: `money`, `time`, `locks`, `recommendations`, `notifications/*`); "only calls `app.listen()` when NODE_ENV !== 'production'" (also skipped under `test`, `index.ts:122`).
- Fix: ~6 bullets + update the stale sentences.

**2. should-fix: PROGRESS.md does not record the final state.** P4 row "진행 중", no final commit; the single 후속 과제 (ENV.md `CLIENT_URL`) is already done (`ENV.md:21`); PLAN §5.3-4 line counts missing. Fix: P4 complete at 2877404 with 2015 / 62 / 1; remove the follow-up; add counts: server `src` 9,355, client `src` 9,806, product 19,161 (from 7,464), tests 22,789, seed 1,709.

**3. nit: SEED_DATA scenario 5 points to the wrong screen.** "15번 프로젝트 상세" → `RecommendedFreelancers` renders only on `/projects/[id]/applications`. Fix: "15번 프로젝트 → 지원자 관리".

**4. nit: BEHAVIOR.md "Found by the suite" table has inconsistent tags and stale line numbers.** Tags in use: `[unlisted]`, `[D-unlisted…]`, `[undocumented divergence]`, `[undocumented]`, none (notifications.test.ts:199/:209). Line refs off: bookmarks 368→299; applications 221/394→183/318; projects-write 1754/1765/1776→1549/1560/1571; notifications 263/273→199/209; lib 111/190→122/201. Fix: tag all `[unlisted]`, drop line numbers for test names.

**5. nit: several concurrency tests would not catch a regression.** S17/PA7 (`settlements.test.ts:411`): removing the user-row lock still passes ("paid/PAID/200/0" accepted, `outcomes.size > 0` always true). S9 (`:444`) sequential only. S5: two batches never concurrent. MS9 (`milestone-plan.test.ts:266`): fixture pre-signed, stale-read never exercised. PY8 (`payments.test.ts:1060`): never reaches the FAILED write. An instructor removing a lock during a recording would see green. Fix: a real race test for at least S17 (and MS9/PY8 if cheap); note the remaining gaps in BEHAVIOR's test-priority section.

**6. nit: two rule IDs have no tagged test; one lock-order statement is wrong.** `MG2` (BEHAVIOR.md:1183) and `NC15` (:1823) in no test name (165/167 covered). MG7 says `Contract → Milestone → … → Conversation`, but `confirmPayment` and dev-complete write Payment before Milestone (`payments.controller.ts:181-185`, `:259-270`); no deadlock today, wording mismatch.

**7. nit: API.md inaccuracies.** `:93-95` role checks on `/users/me/applications`, `/me/bookmarks`, `/me/projects` happen inside handlers with their own 403 messages, not "Insufficient permissions"; `:182` analyze returns 403 for the wrong role before any 429 (`requireRole` before the limiter).

**8. nit: ENV.md / `.env.example` gaps.** `ENV.md:21` says `CLIENT_URL` can be a comma list and is the OAuth redirect target, but OAuth interpolates the raw string (`auth.controller.ts:173,229,232`) — related to Q20; record as a Q. ENV.md doesn't say `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` are read at module load (needed to boot). `.env.example` lacks `MILESTONE_AUTO_APPROVE_DAYS`, `CORS_ORIGINS`; client `.env.example` lacks `API_URL`. `src/types/index.ts:37` "~43 `req.user.id` reads" → 77.

**9. nit: DATABASE.md omissions.** Relations table lacks Conversation↔Message, Message↔MessageAttachment, MilestoneSubmission↔MilestoneAttachment, Notification↔EmailDelivery (SET NULL), User↔PortfolioItem/Career, Contract↔SettlementItem. `:87` lists only CANCELLED as manual transition; code also allows UPCOMING→OPEN and →CLOSED (`projects.controller.ts:410-417`).

**10. nit: settlement screens cramped at 390px.** `/settlements/[id]` items table squeezes the milestone column to ~2 chars; VAT/실지급 and on `/settlements` 건수/총액/실지급액/상태 only reachable by sideways scroll inside the card (no page overflow). Fix: cards below `sm`.

**11. nit: `drive.sh` can pass with a broken first screenshot, and its ports are fixed.** First `home.png` unstyled on a just-started dev server; script still 6/6. Hard-codes :4000/:3000; non-default ports documented only in PLAN §0. Fix: warm up `/` before the loop; read ports from env; document `npx next dev -p N` + `PORT`/`CLIENT_URL` in the skill.

**12. nit: SEED_DATA timing wording depends on seed time.** B#2 "약 3일 남음" can be 4–5 days if seeded between Mon 03:00 and Tue 12:00 KST (`seed.js:1260`); line 99 "다음 수요일" means this week's Wednesday before Wed 10:00 (line 17 is correct).

## Fresh-machine log
Worked from docs alone: `npm install` ×2; `.env` from `.env.example` (dummy values boot); README's `npx prisma migrate dev --name init` creates the DB, applies migrations, seeds, no new migration; `jobs:run`; `scripts/test-db.sh` + `npm test`; client lint/build; both apps start. Needed undocumented knowledge: non-default ports (`npx next dev -p N`, matching `CLIENT_URL`/`GOOGLE_CALLBACK_URL`; `drive.sh` not configurable). `RATE_LIMIT_ENABLED`/`ALLOW_PAYMENT_BYPASS` demo values are explained in ENV.md.

## §5.3 and course scenarios: all pass
Clean clone suite 2015/62/1 (113 s; identical under TZ=UTC + DB timezone=UTC + no `.env`); `it.fails` 47 call sites → 62 cases, every one maps to a D row (D20 is the `it.todo`); lint/build; `jobs:run` after seed claims 0 (recurringEnqueued 3); internal endpoint 200/403/400; every milestone state; reject → resubmit round 3 with PDF + link; approve → settlement item (preview 2,447,500); pay #3 → submit → approve → contract COMPLETED → review; plan edit + both sign → ACTIVE; messages (badges in 4 places, attachment, system messages, tombstone, closed); portfolio/careers (7년 8개월)/public profile/completion 90%; recommendations 98/49/41.82/38.67 and 95/52/30/28; settlements for 4 freelancers, ON_HOLD → SCHEDULED after account registration; preferences locked/email-only; 32 notification links, no 404; `runDueJobs` at now+8d: 23 jobs over 3 passes (B#2 AUTO, dueSoon/overdue, batch, 2 payouts PAID, 10 `mail.sent`); weekly batch at Mon 2026-10-26 03:00 KST: 2 settlements, payouts queued, next batch 11-02. Server 672×200, 5×201, 0 4xx/5xx; console only favicon 404; no page overflow at 390px; no stale labels.

## Doc diffs
API.md vs routes identical (76 + `/health`) except finding 7; public 13 routes / 12 handlers matches CLAUDE.md and `types/index.ts`; auth counts 63/33/13 match. DATABASE.md: 25 models, 13 enums, all correct, omissions only (9). ENV.md vs `env.ts`: all variables documented with matching defaults; gaps in 8. SEED_DATA vs seed.js: every count and amount identical; exceptions 3 and 12. CLAUDE.md: everything true except finding 1's stale items.

## Other
Spec sample 28 rules: 22 OK, 5 weak tests (5), 1 wording (MG7). Q5/Q10/Q11/Q20–Q25 still open. Intended debt intact (Float, String[], GET writes, inline legacy wording, zod on new routes only). No TODO/debugger; only `console.*` in `jobs/cli.ts` and the logger; no tracked secrets. `vercel.json` and CI workflow untouched; CI should pass as-is (no new env vars needed, `gen_random_uuid()` built-in on PG13+; UTC simulation passed). Product code 19,161 (server 9,355 + client 9,806) from 7,464; tests 22,789; seed 1,709. 62 commits since 7a96fcd; 7 sampled commits typecheck alone, 91e8f3a fails as DECISIONS documents. 8 commits carry `Claude Opus 5.5` trailers (8008c29, bfaf83a, 4f1face, 9e0f462, d1f5fec, 32b2042, dffa804, 268d6c2). DECISIONS: no silent contradiction. Leftovers: none (DBs `workbridge`, `workbridge_test` only; no ports; worktrees empty; tree clean; `settings.local.json` = deny `git push`).
