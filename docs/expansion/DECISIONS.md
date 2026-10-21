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
