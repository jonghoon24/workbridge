# P2 검증 1차 (2026-10-21, 71f89e9..cfa2824, HEAD bc1d263)

검증 워커(Opus)가 2A·2B 병합 트리에서 명세 대조, 손 병합 검사, 브라우저 전체 흐름, 추천 점수 수동 재계산, 전체 테스트 두 번을 돌린 결과. 판정: **P3 시작 가능**. 블로커 없음. 1901 통과 / 62 핀 / 1 todo (두 번 동일, flake 없음).

## Findings

**1. should-fix — PF2: a `0000` year returns 500 and leaks internals.**
- `src/lib/time.ts` (`MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/`) and `kstMonthToDate`, used by `schemas/profile.ts`. `0000-01` passes validation, then `kstMonthToDate` produces a negative-year Date Prisma cannot convert → 500 (rules 8, 12) with Prisma's source excerpt and absolute path in the body (D14). `0001-01` → 201. Same path serves portfolio `startedAt`/`endedAt` and both PATCH routes.
- Fix: lower bound on the year (≥ 1900) in `isKstMonth`/`MONTH_PATTERN` → `Month must be a YYYY-MM month`; PF2 test; amend DECISIONS "P2B (구현)" ("연도는 네 자리면 받는다").

**2. should-fix — the portfolio edit modal can wipe a whole item.**
- `components/profile/PortfolioItemModal.jsx:32-46`, `:96-104`: the form starts as `EMPTY` and is filled from `item` in a `useEffect`; PATCH sends every field and empty means clear. Typing in the first frame after opening saved `["사내 대시보드 v2",null,null,"",null]` (3/3 runs). `CareerFormModal.jsx` has the same pattern (fails loudly: empty `startDate` → 400).
- Fix: initialise synchronously (`key={item?.id ?? 'new'}` + `useState(() => toForm(item))`), or send only changed fields.

**3. nit — PROGRESS.md stale.** P2A row still `대기`; record this run (1901 / 62 / 1).

**4. nit — `soft-delete.test.ts` `guardedMutations` order is a merge artefact.** 2A rows interleaved with 2B rows under the `// Phase 2B` comment. All 16 rows (6 P1 + 3 2A + 7 2B) complete and executed. Fix: group and label the 2A block.

**5. nit — duplicated helpers across phases (P4 consolidation candidates).** User-row `FOR UPDATE` helper ×3 (`payoutAccount.service.ts:34`, `portfolio.service.ts:48`, inline `settlements.service.ts:222`); four client Korean error mappers (`settlements/account/page.jsx:16`, `MilestonePlanEditor.jsx:33`, `messages/messageUtils.js:32`, `profile/profileFormat.js:46`); `profileFormat.js` re-declares `KST_OFFSET_MS` and a current-month helper next to `lib/format.js`. One polling hook only; no dead code.

**6. nit — two tests re-assert auth per endpoint, against CLAUDE.md.** `conversations.test.ts:429`, `profile-completion.test.ts:150`.

**7. nit — `RecommendedFreelancers.jsx:17-20` hides 403/404 as an empty result** ("조건에 맞는 프리랜서가 아직 없습니다").

## Checked and found correct
- Every MG/PF/RC/J8 rule has enforcing code and a tagged test (MG2 covered under MG3). MG7: `SELECT … FOR UPDATE`, clock read after the lock, `createdAt = max(now, last+1ms)`, UTC-correct live; system message last write in accept/sign/plan replace/markFunded/submit/reject/approve; no-conversation → warn + null; no lock cycle. Conditional writes first in submit/reject/MG17 delete. PF8/PF11 `lockUserRow` first in create/reorder/delete; image stored outside the lock. J8 steps 1–2 incl. re-enqueue at `createdAt+10m`; no P3 leakage. RC6/RC7 exact comparison; `orderBy` before `take: 200`; recommendation routes don't run the sweep.
- Merge: PROTECTED 61, ROLE_GATED 33, 12/21, public 13/12; `Ids`/`MISSING` complete; soft-delete only adds lines vs both parents; `types/index.ts` comment 12/13; DECISIONS intact; shared files touched by one side only; no `D-2A/2B` tags left.
- 2A↔2B: no coupling; `/my/recommendations` reachable from home; build has both route sets.
- Live: messaging (Korean file names, badges in 4 places, read within one poll, 3 system messages excluded from unread, closed reason in Korean, tombstone, mobile layout, no polling after leaving `/messages`), digest (`nothing-unread`, `rescheduled` at M2+10m exactly, `due` sends nothing), profile (portfolio add/reorder/edit/delete, careers incl. current, summary 6년 10개월 = 82 merged months, completion 55→70→80), public profile without email, scores 84.00/53.67/31.67/29.67 (RC4) and 94.00/47.00 (RC7) recomputed by hand and matched. Edge probes all matched spec.
- Regressions: 1901/62/1 ×2, slowest 1.5 s, known flakes absent, P1 tests not loosened, typecheck/validate/build clean, lint 3 pre-existing warnings + 1 eslint-disable.
- BRIEF/CLAUDE.md: per-route guards, zod/requireActiveUser new routes only, public handlers never read `req.user`, transactions, `deletedAt` filters, Prisma types, dotenv first, `index.ts` untouched, legacy inline wording kept, no TODO/console.log. All P2S spec-review fixes landed.
