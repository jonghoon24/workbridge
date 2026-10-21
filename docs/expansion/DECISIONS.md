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
