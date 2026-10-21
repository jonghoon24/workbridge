# 확장 결정 기록

한 줄에 하나. 워커가 BRIEF.md의 "보편적이고 그럴듯한 쪽" 기준으로 정한 것과, 오케스트레이터가 정한 것을 모두 적는다. 날짜는 결정한 날이다.

## 오케스트레이터 결정 (2026-10-21)

- 운영 환경의 작업 큐 실행 주체는 정하지 않는다. 내부 엔드포인트(`POST /api/internal/jobs/run`)와 CLI만 두고, 외부 스케줄러 연결은 배포와 함께 나중에 정한다. 로컬 개발에서는 `index.ts`가 띄우는 워커가 돈다.
- 첨부 파일은 기존 Supabase 공개 버킷을 그대로 쓴다. 추측하기 어려운 경로로만 보호되며, BEHAVIOR.md의 열린 질문(Q)으로 기록한다. 명세와 구현이 다른 것이 아니므로 알려진 불일치(D)가 아니다. 서명 URL은 버킷 설정 변경이 필요해 나중에 한다.
- 정산 계좌번호는 평문으로 저장하고 API 응답에서는 마스킹한다. 암호화와 계좌 실명 확인은 비용과 규제가 걸린 일이라 나중에 정한다. 역시 BEHAVIOR.md의 열린 질문(Q)으로 기록한다.
- 수수료는 승인된 마일스톤 금액의 10%이고, 수수료에 대한 부가세 10%를 더해 프리랜서가 부담한다. 원 단위 절사. 국내 외주 플랫폼의 흔한 구조를 따른다.

## P0 (2026-10-21)

- 레이트 리밋 윈도는 모두 KST 경계에 맞춘다. 15분·1시간 윈도는 UTC 정렬과 같고, 하루 윈도는 KST 자정에서 시작한다. 그래서 `hit(key, windowMs, limit, now)` 시그니처 하나로 "KST 자정 기준 하루 20회"를 표현한다.
- 레이트 리밋 규칙이 여럿이면 나열 순서대로 평가하고, 앞 규칙이 거부한 요청은 뒤 규칙에 세지 않는다. 거부된 요청도 자기 윈도에는 센다(고정 윈도의 보편적 동작).
- 로그인 IP 제한은 필수 필드 검사보다 먼저 돈다(400도 센다). 실패 제한은 `401 Invalid credentials`만 세고, email이 없거나 문자열이 아니면 건너뛴다.
- `INTERNAL_JOB_TOKEN`이 없을 때 내부 엔드포인트는 `next('router')`로 빠져 매칭되지 않은 경로와 똑같은 응답(Express 기본 HTML 404, Q10)을 낸다. JSON 404면 존재가 드러난다.
- 내부 엔드포인트 body `limit`은 1~500 정수, 기본 50. 토큰 검사를 검증보다 먼저 한다(토큰 없는 호출자가 400으로 아무것도 알아내지 못하게).
- 반복 작업의 다음 회차는 claim 시각 이후 첫 슬롯이다. 워커가 오래 멈췄다 돌아오면 밀린 슬롯을 하나씩 따라잡지 않고 한 번만 실행한다. `ensureRecurringJobs(now)`도 now 이후 첫 슬롯을 넣고 dedupeKey로 멱등이다.
- 핸들러가 없는 작업 type은 재시도하지 않고 바로 FAILED로 둔다(PermanentJobError와 같은 취급).
- `maintenance.cleanup`은 `updatedAt` 기준 14일 지난 SUCCEEDED/CANCELLED 작업과 `expiresAt <= now`인 카운터를 지운다. FAILED 작업은 조사용으로 남긴다.
- 요청 컨텍스트(AsyncLocalStorage)는 `express.json()`/`cookieParser()` 뒤에서 연다. body-parser와 busboy는 소켓의 비동기 컨텍스트에서 이어져서 그 전에 연 컨텍스트를 잃는다. `X-Request-Id` 헤더와 접근 로그는 맨 앞 미들웨어가 `res.locals`로 처리하고, `createUpload`는 multer 콜백에서 컨텍스트를 다시 연다.
- raw SQL의 시각 파라미터는 `'<ISO>'::timestamp(3)`로 넘긴다. Date를 그대로 넘기면 timestamptz가 세션 TimeZone(로컬 PG는 Asia/Seoul)으로 변환되어 Prisma가 쓴 UTC 값과 9시간 어긋난다(`src/lib/sql.ts`).
- 첨부 크기 제한은 "이하" 허용이다. busboy는 정확히 한도 바이트에 닿으면 초과로 보므로 `fileSize`를 `maxBytes + 1`로 준다. 깨진 multipart는 400, Storage 업로드 실패는 502(규칙 8)로 바꾸는 `storeUploadedFile(file, folder)` 헬퍼를 둔다.
- 클라이언트에 ESLint 설정이 한 번도 없어서 `npm run lint`가 대화형 질문에서 멈췄다. Next가 권장하는 `next/core-web-vitals` 설정(`.eslintrc.json`)을 추가했다. 기존 코드의 경고 3건(img, exhaustive-deps)은 손대지 않는다.
- `googleCallback`의 `console.error`는 기존 코드라 그대로 두고, BEHAVIOR.md 규칙 9에 "error 레벨은 errorHandler만"의 유일한 기존 예외로 적었다.
- 테스트 헬퍼 `authed()`에 `put`을 추가했다. P1부터 PUT 라우트가 생긴다.

### P0 검증 1차 반영 (reviews/P0_REVIEW_1.md)

- Next 프록시는 받은 `X-Forwarded-For`를 그대로 넘긴다(자체 호스팅 Next 14는 브라우저 주소를 라우트 핸들러에 주지 않는다). 그래서 `TRUST_PROXY=loopback`은 Next 포트에 신뢰하는 클라이언트만 닿을 때만 안전하다. 남은 위험은 BEHAVIOR.md **Q23**으로 적었다(Q21, Q22는 P1·P2A용으로 예약돼 있어 다음 번호를 썼다).
- 로컬에서는 브라우저, Next, 스크립트가 모두 루프백으로 붙어 모든 로그인이 `::1` 하나로 세어진다(머신 전체 15분 20회). `run-workbridge` 템플릿은 `RATE_LIMIT_ENABLED=false`를 두고, 막히면 `RateLimitCounter`를 비우는 방법을 스킬에 적었다. 레이트 리밋 동작은 테스트(`RATE_LIMIT_ENABLED=true`)가 지킨다.
- stale lock 회수는 `attempts >= maxAttempts`인 작업을 FAILED(`stale lock, attempts exhausted`)로 둔다. 러너는 각 작업 실행 직전에 조건부 `updateMany`로 잠금을 다시 확인하고, 다른 러너가 가져갔으면 건너뛴다. 그래서 `runDueJobs` 결과와 내부 엔드포인트 응답에 `skipped`가 추가됐다.
- 반복 작업 다음 회차 enqueue 실패는 경고만 남기고 작업은 계속 실행한다. 작업 하나의 장부 쓰기 실패는 error 로그 후 그 작업만 stale 회수에 맡기고 배치는 계속한다. 러너가 남기는 로그도 작업 컨텍스트(`jobId`, `requestId`=traceId) 안에서 찍는다.
- 개발 워커는 매 폴링마다 `ensureRecurringJobs`를 부른다. `db:seed`가 Job을 모두 지워도 스케줄이 다시 생긴다.
- **P4 메모:** `RateLimitCounter` 만료 행은 작업 러너(`maintenance.cleanup`)가 돌 때만 지워진다. 운영에는 아직 러너가 없으므로 DEPLOYMENT.md에 "외부 스케줄러가 붙기 전까지 카운터 행이 쌓인다(로그인/분석 요청 수에 비례해 유한)"를 적는다.

## P1 (명세)

- 규칙 식별자 체계: 확장 절의 불릿마다 `M`(금액·마일스톤 상수), `CT`(계약), `PY`(결제), `MS`(마일스톤), `S`(정산), `PA`(지급 계좌), `J`(작업 핸들러) + 번호를 붙이고, 테스트 이름에 `[MS14]`처럼 단다. 번호는 바꾸지 않는다.
- P1이 더하는 알림 type은 PLAN §1.6의 "14개"가 아니라 15개다(§2.1.6 표를 세면 15). 전체 19종(+P3의 다이제스트 = 20).
- C10(공개 프로필)은 §4.1에서 P2B 몫이라 채우지 않았다. C9는 P1 몫(type 목록 확장, `notify()`)만 적고 설정·이메일은 P3에서 고친다.
- Phase 1 알림 지점은 모두 소프트 삭제된 수신자를 건너뛴다(PLAN은 자동 승인만 언급). 상태 변경은 그대로 일어난다. 규칙 5에 적었다.
- 수락 시 계약 `endDate`는 지금처럼 프로젝트 마감일로 둔다. 계획 교체 때만 마지막 기한으로 바뀐다(C2 범위를 마일스톤 생성 하나로 유지).
- 신규 목록(`GET /api/contracts`, `GET /api/settlements`)의 `limit`은 기본 20, 50 초과는 기존 목록처럼 50으로 자른다(400 아님). 0·음수·소수·반복은 400.
- 계획 교체의 기한 검사(오늘 이전 불가, 감소 불가)는 입력 검증 단계라 404보다 먼저다. 합계 검사는 계약을 읽어야 하므로 404 → 403 → 409 다음에 400.
- 서명 시 계획 유효성 검사는 PENDING 계약에서만 한다. ACTIVE 재서명은 기존처럼 멱등이다. 개수 상한·최소 금액·기한은 서명 때 다시 보지 않는다.
- 제출 첨부는 존재·소유권·상태 검사를 통과한 뒤, 트랜잭션 전에 Storage에 올린다. 트랜잭션이 경합에서 409로 지면 올린 객체는 참조 없이 남는다.
- 제출은 파일이 없으면 JSON 본문도 받는다. `links` 단일 값은 1개짜리 목록으로 본다. 링크는 2,000자 이하. 제목 1~100자, 설명 2,000자 이하. 길이는 trim 후 JS `length`.
- 자동 승인 시각은 제출 시각 + N×24시간(KST 날짜 경계 아님). `MILESTONE_AUTO_APPROVE_DAYS`가 없거나 양의 정수가 아니면 7.
- 승인·반려는 대기 중인 자동 승인/리마인더 작업을 취소하지 않는다. 핸들러가 상태와 round를 다시 보고 no-op 성공으로 끝난다. 작업 payload의 row가 없으면 `PermanentJobError`.
- `MILESTONE_PLAN_UPDATED`는 PLAN 엔드포인트 표대로 교체 전에 서명이 하나라도 있었을 때만 보낸다.
- 신규 상태 충돌 메시지: 제출 `Milestone is not awaiting a submission`, 승인·반려 `Milestone is not awaiting review`, 계획 잠금은 COMPLETED에도 같은 `Milestone plan is locked once the contract is active`.
- dev-complete도 순서 규칙(M13)과 `Milestone is already funded`를 지킨다. 키는 `dev_bypass_<milestoneId>`. REFUNDED 메시지는 `… for a refunded milestone`, `POST /` REFUNDED는 `Payment cannot be created for this milestone`.
- confirm의 금액 불일치 메시지 `Payment amount does not match the contract amount`는 기존 테스트가 단언하므로 그대로 둔다.
- `POST /api/payments`는 기존 컨트롤러라 zod를 붙이지 않는다. `{ milestoneId: 12345 }`는 계속 500이고 D14·C7 로깅 테스트의 벡터로 남는다.
- 주간 배치의 정산 기간은 작업의 `runAt`에서 계산한다(P0 반복 작업은 payload가 없다). 늦게 돌아도 원래 주를 정산한다.
- 같은 기간 Settlement에 항목이 더 붙어도 `SETTLEMENT_SCHEDULED`를 다시 보내지 않는다. 재시도가 남은 지급 실패는 알림 없이 재예약하고, 마지막 실패만 `SETTLEMENT_FAILED`.
- 지급 시도는 총 3회(최초 + 재시도 2회). ON_HOLD → SCHEDULED 때 `payoutAttempts`는 유지하고 `failureReason`은 지운다. 재시도 시점에 계좌가 없으면 FAILED → ON_HOLD(PLAN 표에 없던 전이).
- PROCESSING에서 멈춘 정산(이체 중 러너 종료)은 자동 재시도하지 않는다. 이체 여부를 알 수 없어 이중 지급 위험이 있으므로 운영자 몫이고, 그동안 계좌 변경·삭제는 409.
- 소프트 삭제된 프리랜서의 정산은 계좌가 있어도 ON_HOLD(알림 없음).
- 정산 요약에 `onHold`, `failed` 버킷을 더해 모든 정산이 `scheduled`/`onHold`/`failed`/`paidTotal` 중 정확히 하나에 들어가게 했다.
- 지급 계좌번호는 하이픈과 공백을 모두 제거한 뒤 10~14자리. 예금주 비교는 모든 공백 제거 + 대소문자 무시. 계좌 응답은 `{ payoutAccount }`로 감싸고, PUT은 재예약 건수 `rescheduledCount`를 함께 준다.
- 지급 계좌 DELETE는 계좌가 없어도 200(북마크 DELETE와 같은 멱등 관례).
- 마일스톤 상세의 `payoutPreview`는 승인 후에는 정산 항목의 저장값(요율 스냅샷), 그 전에는 현재 요율로 계산한다.

## P1 (명세 검토 반영, 오케스트레이터, 2026-10-21)

- 소프트 삭제된 프로젝트의 자금은 얼리지 않는다. 자동 승인(J2)은 프로젝트 삭제 여부와 무관하게 진행하고, 승인 트랜잭션은 삭제된 프로젝트의 행과 그 맥락의 알림만 건너뛴다. 수동 승인은 그대로 404다. 클라이언트가 글을 지웠다고 프리랜서가 받을 돈이 묶이는 것은 실제 플랫폼에서 허용되지 않는 동작이다.
- `POST /api/payments/confirm`도 삭제된 프로젝트면 캡처 전에 404다. dev-complete와 같은 조건에 같은 답을 준다.

## P1 (명세 검토 1차 반영, reviews/P1_SPEC_REVIEW_1.md)

- 승인 트랜잭션은 계약 row를 `FOR UPDATE`로 먼저 잠그고, 완료 판정은 마일스톤 쓰기 뒤의 새 문장으로 센다(MS16, MS17, MS22). 서로 다른 마지막 두 마일스톤의 동시 승인이 계약을 ACTIVE로 남기지 않게 한다.
- 제출·반려·승인 트랜잭션은 조건부 상태 쓰기를 먼저 하고 round·최신 제출은 그 뒤에 읽는다(MS13, MS16, MS19). 동시 제출이 P2002 500이 아니라 409가 된다.
- 계획 교체는 `SELECT … FOR UPDATE`로 계약의 사전 상태를 잠가 읽고, `MILESTONE_PLAN_UPDATED` 여부를 그 값으로 정한다(MS9).
- confirm 실패 시 FAILED 쓰기는 `status = PENDING`일 때만 한다(PY8). 실제 Toss는 두 번째 confirm을 거절하므로, 무조건 쓰면 이긴 쪽의 COMPLETED가 FAILED로 덮인다.
- 주간 배치의 기간은 `runAt`이 아니라 `dedupeKey`의 슬롯에서 읽는다(S4, J6). 재시도가 `runAt`을 바꾸기 때문이다. 앞의 "P1 (명세)"의 `runAt` 기준 결정을 대체한다. 슬롯 키가 없거나 깨졌으면 `PermanentJobError`.
- 지급 결정(S8/S9)과 지급 계좌 PUT/DELETE는 둘 다 프리랜서 `User` row를 `FOR UPDATE`로 먼저 잠근다(S17, PA7). 검토 제안(계좌 row 잠금 + 쓰기 먼저)은 계좌가 없을 때 새로 만들어지는 경합을 막지 못해 사용자 row로 바꿨다.
- 정산 생성은 `createMany({ skipDuplicates })` 후 읽기로 하고(Prisma upsert 금지), 기존 SCHEDULED 정산에 항목을 붙일 때는 `status = SCHEDULED` 조건부 쓰기를 먼저 한다. 지급 금액은 PROCESSING 전이가 돌려준 `netAmount`다(S5, S9).
- 자동 승인의 조건부 쓰기는 `autoApproveAt <= now`도 요구한다(MS20). 앞 round 작업이 재제출된 round를 바로 승인하지 못한다.
- dev-complete 검사 순서를 `POST /`와 맞췄다(순서 규칙 → 이미 결제됨 → REFUNDED). 마일스톤이 PENDING인데 결제가 COMPLETED인 불일치 상태는 dev-complete가 마일스톤을 FUNDED로 고친다. 금액은 마일스톤 금액으로 다시 쓴다(PY10, PY11).
- 반올림 0원 계약: 지원 시 `expectedRate >= 1`을 요구한다(0 < 값 < 1이면 400 `expectedRate must be at least 1`, [C2]). 실제 플랫폼은 최소 거래 금액이 있고, 0원 마일스톤은 confirm의 `!amount` 검사 때문에 영원히 결제할 수 없다. 기존 테스트 입력(0, 음수, 문자)은 영향이 없다.
- 백필 마이그레이션은 `ROUND(amount::numeric)`을 쓴다. float8 `ROUND`는 .5를 짝수로 보내 `Math.round`(M7)와 1원 어긋난다(PLAN §2.1.1 2단계 수정).
- 수락 시 계약 `endDate`는 기본 마일스톤 기한(수락일 + 30일)으로 둔다. 모집 마감일은 이미 지났을 수 있어 화면에서 틀려 보인다. 앞의 "P1 (명세)"의 endDate 결정을 대체한다([C2]).
- 마일스톤 객체에 `payoutPreview`를 넣는다(MS1). 정산 항목이 없는 백필 승인분은 현재 요율의 M3로 계산한다. `milestoneSummary.contractAmount`(= M7)를 더해 계획 편집기가 반올림하지 않아도 된다(CT6).
- 기한 지난 뒤 결제된 마일스톤의 즉시 `MILESTONE_OVERDUE`는 의도된 동작이다(M16). 지급 재시도 간격 24시간은 ON_HOLD 재예약이 끼면 길어질 수 있다고 적었다(M22). 목록의 `counterpart`는 소프트 삭제돼도 그대로 보인다(Q11 범위, CT3).
- authorization 테스트의 Q10 벡터 `GET /api/contracts`는 `GET /api/users`로 바꾼다(PLAN §1.6). 같은 "마운트된 라우터, 인덱스 라우트 없음" 범주다.
- 새 규칙 식별자는 번호를 이어 붙인다: `MS22`, `S17`, `PA7`. 기존 번호는 바꾸지 않았다.

## P1 (구현)

- 마이그레이션 이름은 오케스트레이터 지시대로 `expansion_milestones_settlement`(PLAN의 `…settlements`가 아님). 비대화형 환경에서는 `migrate dev`가 데이터 손실 경고에서 멈춰서 `prisma migrate diff --from-migrations … --to-schema-datamodel … --shadow-database-url …`로 SQL을 만든 뒤 백필을 손으로 넣었다. 적용 후 같은 diff가 drift 0을 확인한다.
- 백필 검증은 개발 DB 사본에 소수 금액(2500000.5) PENDING 계약, FAILED 결제, 결제 없는 ACTIVE 계약을 더해 했다. 2500001로 반올림되고 FAILED 결제 금액도 맞춰진다.
- 서비스 파일 하나(`milestones.service.ts`)가 계획·결제 반영·제출·승인을 모두 담아서 커밋을 단위별로 나누면 중간 커밋(f10f7af, 91e8f3a, ed9d7e4)은 단독으로 typecheck가 실패한다. 마지막 서버 커밋(f1c3e09)부터 green이다.
- 계획 교체, 승인, 배치의 프리랜서별 트랜잭션은 `{ timeout: 15_000 }`을 준다(Prisma 기본 5초는 잠금 대기가 낀 동시성 테스트에서 빠듯하다).
- 계약 row와 사용자 row 잠금은 명세 그대로 `FOR UPDATE`다. `FOR NO KEY UPDATE`가 더 가볍지만(FK 삽입을 막지 않는다) 동작 차이는 대기 시간뿐이라 명세 문구를 따랐다.
- 배치가 새로 만든 정산에 붙일 항목이 경합으로 사라지면(다른 실행이 먼저 가져감) 빈 정산을 같은 트랜잭션에서 지운다.
- 지급 provider는 `src/lib/payout/provider.ts`의 `setPayoutProvider()`로 바꾼다(테스트 주입). 기본 `LogPayoutProvider`는 마스킹된 계좌만 로그에 남긴다.
- `/api/settlements` 라우터는 `router.use`가 아니라 라우트마다 가드를 붙인다. `router.use`면 매칭되지 않는 하위 경로도 401이 되어 Q10 동작(HTML 404)이 바뀐다.
- Phase 1 알림의 한국어 제목·본문은 `src/lib/notifications/templates.ts`에 있고, 테스트는 type·수신자·href만 단언한다.
- 로컬 실행 확인에서 개발 `.env`의 Supabase가 더미라 첨부 업로드가 502가 된다. `.env`는 그대로 두고 로컬 스텁 + `SUPABASE_URL` 환경 변수로 확인했고, 그 방법과 정산 작업을 미래 시각으로 돌리는 방법을 run-workbridge 스킬 Gotchas에 적었다.
- PA4 재예약 테스트는 과거 주의 정산으로 만든다. 재예약 시각은 실제 시계 기준 "다음 수요일 10:00"이라, 고정된 미래 날짜의 정산이면 원래 지급 작업과 dedupeKey가 겹친다(실제 운영에서는 재예약이 항상 원래 지급 실행 이후라 겹치지 않는다).

## P1 (검증 1차 반영, reviews/P1_REVIEW_1.md)

- PA4 재예약 시각은 now와 정산의 현재 `scheduledPayoutAt` 둘 다보다 뒤인 첫 수요일 10:00 KST다. 러너 시계가 API보다 앞서거나 스킬의 "미래 now" 시연 경로에서 원래 지급 작업과 dedupeKey가 겹쳐 작업이 조용히 안 생기던 문제를 막는다(앞의 "P1 (구현)" PA4 테스트 메모를 대체).
- 신규 목록의 `page` 상한은 1,000,000이다. 상한이 없으면 `skip`이 int64를 넘어 Prisma 오류가 500으로 노출됐다. `pageQuery` 한 곳에서 고쳐 P2 목록도 따른다.
- MS7: 기한 형식·과거 날짜 검사는 항목 검사로 옮겨 배열 순서대로 첫 실패를 보고한다. 감소 검사는 항목 간 비교라 모든 항목이 통과한 뒤에만 돈다(명세에 적음).
- 알림 문구는 따옴표 제목 뒤에 조사를 붙이지 않는다("'X' 마일스톤이"). 받침에 따라 이/가가 갈리기 때문이다.
- 첨부 응답은 MS2의 6개 키만 select한다(`submissionId` 제외).
- 동시 dev-complete의 500은 D22로 고정했다(`it.fails`, 5회 연속 재현). D13과 같은 P2002 미처리이고 운영에서 꺼진 개발 전용 경로라 고치지 않는다.
- 클라이언트: 지급 계좌 화면은 예측 가능한 서버 오류 2개(예금주 불일치, PROCESSING 중 변경)를 한국어로 바꾼다. 상태 라벨과 `MAX_PAYOUT_ATTEMPTS`는 `constants/milestones.js` 한 곳에 둔다. 결제 내역의 "N회차"는 제출 회차와 헷갈려 "#N"으로 바꿨다.

## P2-S (명세)

- 규칙 식별자: 대화방·메시지 `MG`, 포트폴리오·경력·프로필 완성도 `PF`, 추천 `RC`. 미확인 메시지 다이제스트 핸들러는 P1의 `J`를 이어 `J8`. 새 절은 PLAN §4.1 순서대로 Payout account 뒤, Background jobs 앞에 `Conversations` → `Portfolio and careers` → `Profile completion and recommendations`로 넣었다.
- 마이그레이션은 오케스트레이터 지시대로 하나(`expansion_messaging_profile`)다. PLAN §2.2.1/§2.3.1/§3.2의 두 개(`expansion_messaging`, `expansion_profile_portfolio_careers`)를 대체한다.
- 시스템 메시지에 `Message.systemEvent`(String, 알림 type처럼 TS 유니온)를 더했다. 테스트가 한국어 본문이 아니라 이벤트를 단언한다(MG6). 계획 교체도 시스템 메시지로 남기고, 알림과 달리 서명 유무와 상관없이 매번 남긴다.
- 메시지 `createdAt`은 대화방 row를 `FOR UPDATE`로 잠근 뒤 서버 시계로 정하고 `lastMessageAt + 1ms` 이상으로 강제한다(MG7). 대화방 안에서 커밋 순서대로 엄격히 증가하므로 `after` 커서 폴링이 늦게 커밋된 메시지를 놓치지 않는다. 시스템 메시지도 같은 경로라서 작업의 `ctx.now`가 아니라 서버 시계를 쓴다(규칙 11의 now 주입 예외).
- 잠금 순서: `Contract` → `Milestone` → `Conversation`. 대화방 잠금을 잡은 트랜잭션은 계약·마일스톤을 잠그지 않는다. 참여자 row는 단독으로만 잠근다(읽음, 다이제스트).
- 읽음 워터마크는 "대화방의 마지막 메시지"가 아니라 "상대가 보낸 마지막 메시지"의 `createdAt`까지 올린다(PLAN §2.2.2 수정, MG16). 시스템 메시지 시각이 그 뒤의 텍스트를 읽음으로 만들지 않는다. 조건부 쓰기라 뒤로 가지 않는다.
- 발송은 보낸 사람의 워터마크를 바꾸지 않는다. 클라이언트가 스레드를 보여 줄 때 `POST /read`를 부른다. 메시지 목록 GET도 읽음 처리를 하지 않는다(모든 GET은 쓰지 않는다).
- 발송 가능 조건(MG9)에 "상대가 소프트 삭제됨 → 409 `The other participant is no longer active`"를 더했다(탈퇴 회원에게는 보낼 수 없는 것이 보편적). 마감(완료 후 30×24시간, M14처럼 정확한 시간) 판정이 먼저다. 응답에 `canSend`, `closedReason`(`CONTRACT_CLOSED`/`COUNTERPART_INACTIVE`), `closesAt`을 둔다. 시스템 메시지는 마감과 무관하게 남는다.
- 메시지 삭제: 5분 "미만"만 허용(정확히 5분이면 409), 이미 삭제된 메시지는 200(멱등), 시스템 메시지와 상대 메시지는 403. 저장소 파일은 지우지 않고 Q21에 적었다.
- 메시지 목록 `limit`은 기본 30, 100 초과는 100으로 자른다(CT2처럼 400 아님). 응답은 커서와 상관없이 항상 오래된 순. `before`와 `after`를 함께 주면 400, 이 대화방 메시지가 아닌 커서는 404/403 다음에 400.
- 대화방 목록은 `lastMessageAt desc`(메시지 없는 대화방은 맨 뒤) → `createdAt desc` → `id asc`. 상세 응답은 `{ conversation }`으로 감싼다(PA2처럼).
- 백필 대화방과 참여자의 `createdAt`은 계약의 `createdAt`이다. `now()`를 `timestamp(3)`에 넣으면 세션 TimeZone(로컬 Asia/Seoul) 때문에 9시간 어긋난다(P0의 `sql.ts` 결정과 같은 이유). 시스템 메시지는 백필하지 않는다.
- 미확인 다이제스트는 PLAN §2.4.3과 달리 P2A가 enqueue와 핸들러 1~2단계(참여자 잠금, 0개·삭제면 no-op)를 구현하고 P3가 3~4단계(60분 throttle, `EmailDelivery.contextKey`, 이메일)를 채운다(MG21, J8). 핸들러 없는 type은 즉시 FAILED라서 enqueue만 먼저 넣을 수 없다. 같은 쌍의 PENDING 작업 확인은 대화방 잠금 안이라 발송끼리는 경합하지 않는다.
- 삭제된 프로젝트의 자동 승인은 시스템 메시지도 남기지 않는다(MS17이 알림을 생략하는 조건과 같다).
- P2는 인앱 알림 type을 더하지 않는다(19종 그대로). `MESSAGE_UNREAD_DIGEST`는 이메일 전용이고 P3가 정책 표와 함께 넣는다.
- `GET /api/contracts`의 `unreadMessageCount`와 `GET /api/contracts/:id/conversation`은 CT 절을 고치지 않고 MG18·MG19로 적었다(P1 문장 수정 최소화).
- 월 값(`YYYY-MM`)은 KST 그 달 1일 0시로 저장하고 응답에서는 `YYYY-MM` 문자열로 돌려준다(PF2). 포트폴리오와 경력 모두 이번 달(KST) 이후는 400, 끝 달은 시작 달 이상(같은 달 허용). 포트폴리오 `endedAt`만 있으면 400.
- 포트폴리오·경력 생성과 포트폴리오 순서 변경은 사용자 row `FOR UPDATE`(PA7·S17과 같은 잠금) 아래에서 개수와 `sortOrder`를 정한다(PF8). 개수 초과 409는 이미지 저장 전에 한 번, 잠금 아래에서 다시 본다. 수정·삭제는 잠그지 않는다.
- 남의 포트폴리오·경력 id는 404가 아니라 403(규칙 3, MS5와 같은 순서). 삭제 응답은 `{ id, deleted: true }`. 교체·삭제된 이미지 파일은 저장소에서 지우지 않는다.
- 포트폴리오 스킬은 각 50자 이하, 문자열이 아니면 400(이 라우트에는 D16이 없다). `skills`는 `PATCH /me`처럼 반복 필드나 쉼표 문자열을 받는다.
- 경력 정렬: `startDate desc` → 재직 중 먼저 → `endDate desc` → `createdAt desc` → `id asc`. 경력 합계는 양끝 포함 개월 수이고 겹치거나 맞닿은 구간을 병합한다.
- 공개 GET 2개는 페이지네이션 없이 상한(20/30)이 묶는다. `GET /api/users/me/portfolio`는 따로 두지 않는다(공개 라우트의 id `me` → 404).
- 완성도 응답 `items`는 `{ key, weight, done }`이고 한국어 라벨은 클라이언트가 붙인다. 역할은 토큰이 아니라 DB row 기준. `isComplete`와 `percent`는 독립이다.
- 추천 `limit`은 기본 10, 20 초과는 20으로 자른다. `page`는 없다. 두 추천 모두 지연 스윕을 부르지 않는다.
- 프리랜서 추천: 프로젝트 상태와 무관하게 쓸 수 있고, 이 프로젝트에 지원한 적이 있으면(상태 무관) 후보에서 뺀다. DB prefilter에는 완성도 조건 중 DB로 표현되는 것(skills 비어 있지 않음, activityCategory not null, experienceYears ≥ 0, hourlyRate > 0)을 넣고, 공백 activityCategory만 200개 컷 뒤에 메모리에서 거른다. 요구 스킬이 없는 프로젝트는 스킬·포트폴리오 점수가 0이고 모든 완성 프리랜서가 후보다.
- 프로젝트 추천: 최신성은 `createdAt` 기준 7일까지 10점, 7~30일 선형 감소, 30일부터 0점("30일에 걸쳐"를 등록 후 30일에 0이 되는 것으로 정했다). 동점은 마감 임박 순 → `id`. 삭제된 의뢰인의 프로젝트는 거르지 않는다(Q11 범위).
- 점수 반올림은 `Math.round(x × 100) / 100`이고 정렬도 반올림한 점수로 한다. 카테고리 비교는 양쪽 trim 후 정확히 일치.
- `makeContractScenario`는 수락이 만드는 것과 같게 대화방과 참여자 둘도 만든다. `seed.js`는 시연 메시지 없이 대화방이 없는 모든 계약에 대화방과 참여자를 만든다(P4 전에도 "계약마다 대화방" 불변식 유지).
- `src/index.ts`에 빈 라우터 두 개(`conversations.routes.ts`를 `/api/conversations`에, `profile.routes.ts`를 `/api/users`의 `userRoutes` 다음에)를 미리 마운트했다(PLAN §3.2). 2A와 2B는 `index.ts`를 고치지 않는다. 빈 라우터는 매칭되지 않는 경로를 그대로 흘려보내므로 Q10 동작이 바뀌지 않는다.

## P2-S (명세 검토 반영, reviews/P2S_SPEC_REVIEW_1.md)

- J8 2단계에 재확인을 더했다. 미확인 메시지가 남아 있어도 가장 오래된 미확인 메시지가 `ctx.now − 10분`보다 새것이면 보내지 않고 그 메시지 시각 + 10분에 다시 enqueue한다(같은 쌍의 PENDING이 없을 때만, 실행 중인 자기 자신은 RUNNING이라 세지 않는다). "10분 안에 읽으면 메일이 가지 않는다"를 실제로 지키게 한다(검토 1).
- 포트폴리오 DELETE도 사용자 row 잠금을 먼저 잡는다(PF8, PF11). 순서 변경이 잠금 아래에서 읽은 항목을 동시 삭제가 지워 P2025 500이 나는 경합을 막는다. 경력 삭제와 수정은 여전히 잠그지 않는다(검토 2).
- 대화방이 없는 계약(데이터 복구 상황, `makeContract`만 쓴 테스트 픽스처)에서는 시스템 메시지를 남기지 않고 `warn` 로그만 남기며 이벤트는 그대로 진행한다(MG7). P1의 D22 dev-complete 경합 테스트가 엉뚱한 이유로 실패하지 않게 한다(검토 3).
- 잠금 순서에 이벤트의 다른 쓰기(Project 등)를 넣고, 시스템 메시지는 항상 이벤트 트랜잭션의 마지막 쓰기라고 적었다(MG7, 검토 6).
- 추천의 카테고리 비교는 trim 없이 저장값 그대로 정확히 일치로 통일한다(RC4, RC6, RC7). prefilter(DB)와 점수가 같은 비교를 쓴다. 앞의 "P2-S (명세)"의 "양쪽 trim 후" 결정을 대체한다(검토 7).
- 새 라우터 두 개(`conversations.routes.ts`, `profile.routes.ts`)는 가드를 라우트마다 붙이고 `router.use`를 쓰지 않는다. `/api/users`에는 Q10 벡터(`GET /api/users`, `DELETE /api/users/me`)와 공개 GET(PF16, PF17)이 있다. P1 settlements와 같은 결정(검토 4).
- `Message.sender`의 `onDelete: Restrict`는 의도다(기본 SetNull이면 TEXT 메시지가 발신자 없는 가짜 시스템 메시지가 된다). 스키마 주석으로 남겼고 마이그레이션 변화는 없다(검토 10).
- PLAN §2.4.3 머리에 P3 워커용 한 줄을 달아 다이제스트 분담과 대체된 PLAN 문단을 이 문서로 안내한다. PLAN 본문은 고치지 않는다(검토 9).

## P2-S (핸드오프)

2A(메시지)와 2B(프로필) 워커가 병렬로 일할 때의 파일 소유권. 머지 담당은 이 표로 충돌을 판단한다(PLAN §3.4와 함께 읽는다).

| 파일 | 규칙 |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/`, `test/helpers/db.ts`, `src/index.ts` | 아무도 고치지 않는다(P2-S가 끝냈다). 필요하면 오케스트레이터에게 올린다 |
| `test/helpers/factories.ts`, `test/helpers/api.ts` | 읽기 전용. 필요한 로컬 헬퍼는 각 테스트 파일 안에 둔다 |
| `src/schemas/common.ts`, `src/schemas/pagination.ts` | 읽기 전용. 각자의 한도·커서·월 헬퍼는 자기 `src/schemas/<domain>.ts`에 둔다 |
| `src/lib/time.ts` | 2B만(PF2의 KST 월 헬퍼) |
| `test/lib.test.ts` | 2B만. 2A의 순수 함수 테스트는 자기 테스트 파일에 둔다 |
| `src/routes/conversations.routes.ts`, `src/routes/contracts.routes.ts`(MG18), `src/controllers/applications.controller.ts`(수락 7단계), `src/controllers/contracts.controller.ts`(서명), `src/controllers/payments.controller.ts`, `src/services/milestones.service.ts`, `src/services/contracts.service.ts`(MG19), `src/jobs/types.ts`, `src/jobs/registry.ts`, `src/lib/notifications/templates.ts`(필요할 때만) | 2A만 |
| 신규 `src/services/messaging.service.ts`, `src/controllers/conversations.controller.ts`, `src/schemas/conversations.ts`, `src/jobs/handlers/messageDigest.ts`, `test/conversations.test.ts`, `test/messages.test.ts`, `test/message-read.test.ts` | 2A |
| `test/applications.test.ts`, `test/contracts.test.ts`, `test/milestones.test.ts`, `test/payments.test.ts`(시스템 메시지 단언) | 2A만 |
| `src/routes/profile.routes.ts`, `src/routes/projects.routes.ts`(RC3), `src/controllers/users.controller.ts`(C10), `src/lib/profileCompletion.ts` | 2B만 |
| 신규 `src/lib/recommendations.ts`, `src/services/portfolio.service.ts`, `src/services/careers.service.ts`, `src/controllers/profile.controller.ts`, `src/controllers/recommendations.controller.ts`, `src/schemas/profile.ts`, `test/portfolio.test.ts`, `test/careers.test.ts`, `test/recommendations.test.ts`, `test/profile-completion.test.ts` | 2B |
| `test/users.test.ts` | 2B만 |
| 클라이언트 `components/layout/Header.jsx`, `middleware.js`(`/messages`), `components/messages/`, `/messages` 페이지 | 2A만 |
| 클라이언트 `components/profile/`, `/profile/*`, `/users/[id]`, `/my/recommendations` 페이지 | 2B만(`/my`는 이미 보호됨) |
| 클라이언트 `lib/format.js`, `components/ui/*` | 읽기 전용 |
| `test/authorization.test.ts`, `test/soft-delete.test.ts`(신규 행은 `guardedMutations`에만), `src/types/index.ts`(공개 라우트 주석), `docs/BEHAVIOR.md`(D 임시 태그 `D-2A-n`/`D-2B-n`), `docs/expansion/DECISIONS.md`, `PROGRESS.md` | 공유. 둘 다 살리고 머지 담당이 손으로 합친다 |

`authorization.test.ts`의 개수(머지 후 기대값, 현재 → 2A → 2B 합계):

| 단언 | 현재 | 2A | 2B | 합계 |
|---|---|---|---|---|
| `PROTECTED_ROUTES` | 43 | +8(대화방 7 + `GET /api/contracts/:id/conversation`) | +10(포트폴리오 4, 경력 3, 완성도 1, 추천 2) | 61 |
| `ROLE_GATED_ROUTES` | 24 | 0 | +9 | 33 |
| CLIENT / FREELANCER 분할 | 11 / 13 | 0 / 0 | +1(RC3) / +8 | 12 / 21 |
| `PUBLIC_ROUTES`(라우트 / 핸들러) | 11 / 10 | 0 | +2 / +2(PF16, PF17) | 13 / 12 |

`Ids` 인터페이스와 `MISSING`에는 2A가 `conversationId`, `messageId`를, 2B가 `portfolioItemId`, `careerId`를 더한다.

## P2B (구현)

- 추천 라우트 경로는 BEHAVIOR.md를 따른다: `GET /api/projects/:id/recommended-freelancers`(RC3), `GET /api/users/me/recommended-projects`(RC6). RC3에도 규칙 12대로 `requireActiveUser`를 붙였다(`authenticate → requireActiveUser → requireRole('CLIENT') → validate`).
- 추천은 서비스 파일 없이 `src/lib/recommendations.ts`가 prefilter 쿼리와 점수(RC4, RC7 표를 주석으로 한 번만)를 모두 담는다(핸드오프 표의 파일 목록). 후보의 `avgRating`은 `GET /api/users/:id`처럼 받은 리뷰 전부의 평균이다.
- 포트폴리오 PF5 정렬은 `portfolio.service.ts`의 `PORTFOLIO_ORDER`가 기준이고, `lib/recommendations.ts`는 lib → services 의존을 피하려고 같은 정렬을 직접 적었다.
- 월 헬퍼(`isKstMonth`, `kstMonthToDate`, `kstMonthString`, `kstMonthOrNull`, `kstMonthIndex`)는 `lib/time.ts`에 있다. 연도는 네 자리면 받는다(하한 없음, 명세에 없음). "미래" 판정은 요청 시각의 KST 달과 문자열 비교다.
- 경력 생성에서 `startDate`가 없으면 `startDate: Month must be a YYYY-MM month`다(PF13은 필수라고만 적었다). `removeImage`가 true/false가 아니면 `removeImage: Must be true or false`. 스킬 배열에 문자열이 아닌 값이 있으면 zod union 메시지(`skills: Invalid input`)라 접두어만 의미가 있다.
- `removeImage`와 `image`를 같이 보낸 400은 스키마가 파일을 보지 못해 컨트롤러에서 검사하지만, 서비스 호출 전이라 PF7의 "검증 → 존재" 순서를 지킨다.
- PATCH의 병합 행 월 검사는 시작 쪽을 바꿔서 생긴 위반도 끝 필드 경로로 보고한다(`startedAt: ''`이면 `endedAt: Start month is required with an end month`, 시작이 저장된 끝보다 뒤면 `endDate: End month must not be before start month`). 생성의 교차 검사와 같은 문구다.
- 바꿀 필드가 하나도 없는 PATCH(예: `removeImage=false`만)는 쓰지 않고 200으로 현재 행을 돌려준다(`updatedAt` 그대로). Prisma는 데이터 없는 `updateMany`를 0행으로 보고해 404가 되던 것을 막았다.
- 포트폴리오 이미지 저장은 잠금 트랜잭션 밖(사전 개수 검사 뒤)에서 한다. 네트워크 호출 동안 사용자 row 잠금을 쥐지 않기 위해서다. 경합에서 진 요청의 이미지는 참조 없이 남는다(PF9 그대로).
- 순서 변경은 잠금 아래에서 항목마다 `update`를 한 번씩 한다(최대 20행). 삭제와의 경합 테스트는 5회 반복해 500이 없고 결과가 둘 중 하나(200 후 삭제, 또는 삭제 후 400)임을 본다.
- `careerSummary`는 끝이 시작보다 앞선 구간(API로는 만들 수 없음)을 무시한다.
- 완성도 타입(`ProfileScoreInput`, `ProfileCompletionCounts`, `ProfileCompletionItem`, `ProfileCompletion`)은 `src/types/index.ts`에 더했다. `GET /me/profile-completion`은 가드와 읽기 사이에 row가 사라지면 404 `User not found`(사실상 도달 불가).
- 클라이언트: 완성도 라벨과 서버 오류 번역은 PLAN §2.3.4의 `lib/profileCompletion.js` 확장 대신 `components/profile/`에 두었다(핸드오프 표의 "새 헬퍼는 components/profile 안" 규칙, p2a-client와 충돌 방지). 기존 게이트 함수는 그대로다.
- 클라이언트 이미지는 `components/profile/ProfileImage.jsx` 한 곳에서 `<img>`(+ eslint-disable 한 줄)로 그린다. 저장소 호스트가 환경마다 달라 `next/image`의 remotePatterns 밖일 수 있다. lint 경고는 기존 3건 그대로다.
- 클라이언트 월 입력은 `<input type="month">`(값이 곧 YYYY-MM)이고 `max`는 KST 이번 달이다. 포트폴리오 수정은 항상 multipart로 모든 필드를 보낸다(빈 값 = 지우기). 순서 변경은 화면을 먼저 바꾸고 실패하면 서버 목록을 다시 읽는다.
- 홈의 추천 섹션은 로그인한 프리랜서에게만 보이는 클라이언트 컴포넌트(`HomeRecommendedProjects`)다. 홈 페이지 자체는 서버 컴포넌트로 남는다.
- **P4 메모:** 시드의 프로젝트는 모두 마감이 지나 새 시드에서는 프로젝트 추천이 비어 있다. 실행 확인에서는 의뢰인이 모집 중 프로젝트 3개를 API로 올려 확인했다. P4 시드에 마감이 남은 OPEN 프로젝트와 포트폴리오·경력을 넣는다. 또 `seed.js`는 dotenv를 읽지 않아 새 worktree에서는 `.env`를 셸에 export해야 돈다.

## P2A (구현)

- 시스템 메시지의 한국어 본문은 `services/messaging.service.ts`의 `SYSTEM_BODIES` 한 곳에 둔다(`lib/notifications/templates.ts`는 고치지 않았다). 마일스톤 제목, 제출 회차, 반려 사유를 본문에 넣는다. `MessageSystemEvent` 유니온도 같은 파일에 두고 `src/types/index.ts`에서 다시 내보낸다(`NotificationType`과 같은 방식).
- 시스템 메시지는 `postSystemMessage(tx, contractId, event, vars)` 하나로 남긴다. 결제 전이는 `markFunded` 끝에서 남겨 confirm과 dev-complete가 같은 경로를 탄다. 승인은 알림과 같은 `!projectDeleted` 블록 안에서 `MILESTONE_APPROVED`/`MILESTONE_AUTO_APPROVED` 다음 `CONTRACT_COMPLETED` 순서로 남긴다.
- MG8(안 읽은 수)은 raw SQL 하나(`unreadRows`)로 계산하고 대화방 목록, 상세, 총합(MG12), 계약 목록(MG19), MG18이 모두 이것을 쓴다. 열끼리 비교하므로 `sqlTimestamp`가 필요 없다. 총합만 프로젝트 삭제 조건(MG10)을 SQL에 넣고, 나머지는 호출하는 쪽 조회가 이미 거른다.
- MG15의 "본문이 비었고 파일도 없음" 400은 zod 본문 스키마가 `req.files`를 볼 수 없어 컨트롤러 첫 줄에서 같은 메시지(`body: Message or attachment is required`)로 낸다. 조회 전이라 검증 단계 순서는 같다. 문자열이 아닌 `body`는 zod 기본 메시지(`body: Expected string, received number`)로 400.
- 상태가 COMPLETED인데 `completedAt`이 null인 계약(데이터 이상, `makeContractScenario({ contract: { status: 'COMPLETED' } })` 픽스처)은 `closesAt: null`로 보고 MG9 첫 행에 걸리지 않는다(발송 허용).
- 미확인 다이제스트의 "같은 쌍의 PENDING 작업" 검사는 `payload`의 JSON path 두 개(`conversationId`, `recipientId`)로 찾는다. J8 2단계를 통과한 실행(`due`)은 Phase 2A에서 `unread digest` info 로그(`outcome`, `unreadCount`)만 남기고 SUCCEEDED로 끝난다. 결과 값은 `not-applicable`/`nothing-unread`/`rescheduled`/`due`.
- 계획 교체와 자동 승인의 시스템 메시지 테스트는 핸드오프 표에 없는 `milestone-plan.test.ts`, `auto-approval.test.ts` 대신 `conversations.test.ts`의 "system messages"에 두었다. 수락·서명·결제·제출·반려·승인은 표대로 각 파일에 더했다.
- 클라이언트: `usePolling`은 PLAN §2.2.4의 `hooks/` 대신 소유권 표대로 `components/messages/`에 둔다. 스레드 5초, 헤더 배지 30초(MG20), 대화방 목록은 명세에 주기가 없어 10초로 정했다. 내 메시지의 읽음 표시는 5초마다 받는 대화방 상세의 `counterpartLastReadAt`으로 다시 계산한다(`after` 폴링은 이미 받은 메시지를 다시 주지 않는다). 같은 이유로 상대가 지운 메시지는 새로고침 전까지 화면에 남는다.
- 클라이언트: `/my/contracts` 항목에는 대화방 id가 없어(MG19는 수만 준다) "대화" 버튼을 누를 때 `GET /api/contracts/:id/conversation`으로 찾아 이동한다. 첨부는 이미지도 썸네일 없이 파일 칩으로 보여준다(공개 URL Q21, `<img>` lint 경고를 늘리지 않는다). 삭제 버튼은 터치 기기에서도 보이도록 hover 전용으로 숨기지 않는다.
- 로컬 실행 확인의 업로드 스텁은 병렬 워커(P2B)와 겹치지 않게 54322 포트를 썼다(스킬 Gotchas는 54321). 서버 테스트 1659 통과(+185), it.fails 62(변화 없음), todo 1. D-2A 핀은 없다.
