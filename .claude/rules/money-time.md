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

- 모든 금액은 **원 단위 정수**다. 수수료, 부가세, 반올림과 그 상수는 `lib/money.ts`의 export만 쓴다
  (`payoutBreakdown`, `sumBreakdowns`, `wholeWon`, `PLATFORM_FEE_RATE_BPS` 등). 합계는 `sumBreakdowns`로 항목을 더하고,
  총액에서 다시 계산하지 않는다.
- 다른 곳에서 금액에 인라인 `* 0.1`, `Math.round(amount * …)`, `toFixed`를 쓰지 않는다.
- 요청 본문의 금액은 `src/schemas/common.ts`의 `bodyWholeWon(label, { min })`으로 받는다(정수가 아니면 400).
  정수 검사 없는 `z.number()`나 `z.coerce.number()`로 받지 않는다.
- 규칙과 그 이유: `docs/domain/milestones-payments.md` "돈 규칙".

## 시간 — `src/lib/time.ts`, 고정 UTC+9

- 달력 규칙("오늘", 마감일, 일·월 단위 구간, KST 기준 정기 일정)은 `lib/time.ts`의 함수로 계산한다.
  시간대 라이브러리는 쓰지 않는다.
- 달력 로직에 호스트 시간대 getter/setter(`getDate()`, `getDay()`, `getHours()`, `getMonth()`, `getFullYear()`,
  같은 이름의 `set*()`, `toLocaleDateString()`)를 쓰지 않는다 — CI와 Vercel은 UTC, 개발 PC는 KST라서 기기마다 답이 달라진다.
- 시간에 따라 달라지는 함수는 `now: Date`를 인자로 받는다. 서비스와 작업 핸들러는 `new Date()`를 직접 부르지 않는다:
  HTTP 경계의 컨트롤러가 `new Date()`를 넘기고, 작업 핸들러는 `ctx.now`를 쓴다.
