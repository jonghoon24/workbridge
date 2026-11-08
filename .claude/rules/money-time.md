---
paths:
  - "workbridge-server/src/services/**/*.ts"
  - "workbridge-server/src/jobs/**/*.ts"
  - "workbridge-server/src/schemas/**/*.ts"
  - "workbridge-server/src/lib/money.ts"
  - "workbridge-server/src/lib/time.ts"
  - "workbridge-server/src/lib/rateLimit*.ts"
  - "workbridge-server/src/controllers/{payments,milestones,settlements,contracts,contractList}.controller.ts"
  - "workbridge-server/test/{money,time,settlements,milestones,payments,auto-approval}.test.ts"
---

# Money and time

## Money — `src/lib/money.ts` only

- Every amount is **integer won**. Fees, VAT and rounding go through `lib/money.ts`:
  `payoutBreakdown(gross)` (M3: `fee = floor(gross × 10%)`, `vat = floor(fee × 10%)`,
  `net = gross − fee − vat`), `sumBreakdowns(items)` (M5: totals are sums of items, never
  recomputed from total gross), `wholeWon()` (M7), and the constants
  `PLATFORM_FEE_RATE_BPS`, `MIN_MILESTONES`/`MAX_MILESTONES`, `MIN_MILESTONE_AMOUNT`.
- No inline `* 0.1`, `Math.round(amount * …)` or `toFixed` for money anywhere else.
- The `Float` money columns in `schema.prisma` are known debt. Don't migrate them.
- Zod schemas for new routes reject non-integer amounts (rule 12) → 400.

## Time — `src/lib/time.ts`, fixed UTC+9

- Calendar rules ("today", due dates, day windows, the Monday 03:00 KST weekly settlement batch,
  Wednesday 10:00 KST payouts) use `lib/time.ts`: `startOfKstDay`, `kstDateString`,
  `kstDateToEndOfDay`, `nextKstTimeOfDay`, `nextKstWeekday`, `kstMonth*`.
- No timezone library. No host-timezone getters/setters for calendar logic
  (`getDate()`, `getHours()`, `getDay()`, `setHours()`, `toLocaleDateString()` …) — CI and Vercel
  run in UTC, laptops in KST, so these give different answers per machine. A PostToolUse hook
  flags them.
- Functions take `now: Date` as an argument. Services and job handlers never call `new Date()`
  themselves: controllers pass `new Date()` at the HTTP boundary, job handlers use `ctx.now`.
  Tests control time by passing `now` / `runJobs(now)` — never fake timers.
