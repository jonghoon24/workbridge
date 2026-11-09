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

# 금액과 시간

## 금액 — `src/lib/money.ts`에서만

- 모든 금액은 **원 단위 정수**다. 수수료, 부가세, 반올림은 `lib/money.ts`를 거친다:
  `payoutBreakdown(gross)`(`fee = floor(gross × 10%)`, `vat = floor(fee × 10%)`,
  `net = gross − fee − vat`), `sumBreakdowns(items)`(합계는 항목의 합이고, 총액에서 다시
  계산하지 않는다), `wholeWon()`(계약 금액의 원 단위 반올림), 그리고 상수
  `PLATFORM_FEE_RATE_BPS`, `MIN_MILESTONES`/`MAX_MILESTONES`, `MIN_MILESTONE_AMOUNT`.
- 다른 곳에서 금액에 인라인 `* 0.1`, `Math.round(amount * …)`, `toFixed`를 쓰지 않는다.
- `schema.prisma`의 `Float` 금액 컬럼은 알고 있는 부채다. 마이그레이션하지 않는다.
- 새 라우트의 zod 스키마는 정수가 아닌 금액을 거부한다(`z.number().int()`) → 400.
- 규칙과 그 이유: `docs/domain/milestones-payments.md` "돈 규칙".

## 시간 — `src/lib/time.ts`, 고정 UTC+9

- 달력 규칙("오늘", 마감일, 일 단위 구간, 월요일 03:00 KST 주간 정산 배치, 수요일 10:00 KST 지급)은
  `lib/time.ts`를 쓴다: `startOfKstDay`, `kstDateString`, `kstDateToEndOfDay`, `nextKstTimeOfDay`,
  `nextKstWeekday`, `kstMonth*`.
- 시간대 라이브러리는 쓰지 않는다. 달력 로직에 호스트 시간대 getter/setter
  (`getDate()`, `getDay()`, `getHours()`, `getMonth()`, `getFullYear()`, 같은 이름의 `set*()`,
  `toLocaleDateString()`)를 쓰지 않는다 — CI와
  Vercel은 UTC, 개발 PC는 KST라서 기기마다 답이 달라진다. PostToolUse 훅이 이것을 잡는다.
- 함수는 `now: Date`를 인자로 받는다. 서비스와 작업 핸들러는 `new Date()`를 직접 부르지 않는다:
  HTTP 경계의 컨트롤러가 `new Date()`를 넘기고, 작업 핸들러는 `ctx.now`를 쓴다.
  테스트는 `now` / `runJobs(now)`를 넘겨 시간을 제어한다 — 가짜 타이머는 쓰지 않는다.
