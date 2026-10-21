# WorkBridge 확장 실행 계획 (PLAN)

이 문서는 `docs/expansion/BRIEF.md`를 구체적인 작업 단위로 옮긴 것이다. BRIEF.md가 상위 규칙이고, 이 문서와 BRIEF.md가 충돌하면 BRIEF.md를 따른다.
각 Phase는 이 문서만 읽은 구현 워커가 단독으로 집어 실행할 수 있게 썼다. 워커는 시작 전에 BRIEF.md, `CLAUDE.md`, 이 문서의 "공통 규칙"(§0)과 자기 Phase 절을 읽는다.

---

## 0. 공통 규칙 (모든 Phase)

- **명세 먼저.** 도메인마다 `docs/BEHAVIOR.md`에 명세 절을 먼저 쓰고 커밋한 다음 스키마 → 서버 → 테스트 → 클라이언트 순으로 간다. 테스트는 명세를 오라클로 삼는다. 구현이 명세와 다르면 `it.fails`로 고정하고 BEHAVIOR.md의 Outstanding 표에 새 번호(D22부터)를 붙인다.
- **신규 도메인 코드 배치** (서비스 레이어는 신규 도메인에만 둔다. 기존 컨트롤러는 리팩터링하지 않는다.)
  - `src/services/<domain>.service.ts` — 비즈니스 로직, 트랜잭션. 컨트롤러는 파싱 → 서비스 호출 → 응답만 한다.
  - `src/schemas/<domain>.ts` — zod 스키마. 신규 라우트에만 `validate()` 미들웨어로 붙인다.
  - `src/jobs/handlers/<type>.ts` — 작업 큐 핸들러.
  - 기존 규칙은 그대로다: `AppError`, `try/catch → next(err)`, 핸들러에 `Promise<void>` 표기 금지, `deletedAt: null` 필터, Prisma 생성 타입 재사용, `import 'dotenv/config'` 첫 줄.
- **신규 라우트 공통 가드.** 신규 라우트는 `authenticate` 뒤에 `requireActiveUser`(Phase 0에서 추가, 소프트 삭제된 사용자면 401)를 붙인다. 기존 라우트에는 붙이지 않는다. 그래서 D12는 기존 라우트에서만 계속 남는다(의도된 혼재).
- **트랜잭션 안의 유니크 충돌.** Postgres는 interactive transaction 안에서 쿼리가 실패하면 트랜잭션 전체를 abort한다. 트랜잭션 안에서 "있으면 무시"가 필요하면 P2002를 catch하지 말고 `createMany({ skipDuplicates: true })`(= `ON CONFLICT DO NOTHING`)나 조건부 `updateMany`를 쓴다. 작업 큐 `enqueueJob`이 이 방식이다.
- **시간 주입.** 시간에 의존하는 서비스와 핸들러는 `now: Date = new Date()` 인자를 받는다. 테스트는 `vi.useFakeTimers`를 쓰지 않고 `runDueJobs({ now })`처럼 시각을 넘긴다. Prisma와 fake timer를 같이 쓰면 불안정하다.
- **KST.** 정산 주기, 마감일, "오늘" 판정은 한국 시간(UTC+9, DST 없음) 고정 오프셋으로 계산한다. 시간대 라이브러리는 넣지 않는다. 헬퍼는 `src/lib/time.ts`(`startOfKstDay`, `kstDateToEndOfDay`, `nextKstWeekday`)에 둔다.
- **금액.** 금액 컬럼이 `Float`인 기존 부채는 그대로 둔다. 신규 도메인에서는 값을 항상 원 단위 정수로 다루고, 계산은 `src/lib/money.ts`만 거친다(§2.1 금액 규칙).
- **업로드.** 기존 `uploadToSupabase(buffer, mimetype, filename)`에 4번째 인자 `folder = 'profiles'`를 더한다. 기존 호출부는 바꾸지 않는다. 신규 도메인은 Phase 0의 `attachmentUpload`(문서/압축 포함)나 `imageUpload`(이미지 전용) 미들웨어만 쓰고, 기존 `upload`는 쓰지 않는다. 기존 `upload`의 파일 필터는 일반 `Error`를 던져 500(D6)이 된다. 테스트는 `vi.mock('@supabase/supabase-js')`로 storage를 stub한다.
- **저장 키와 파일명.** Storage 객체 키는 항상 `<folder>/<uuid>.<ext>`(ASCII만)이다. 원본 파일명은 키에 넣지 않는다. multer 1.4.5-lts가 Busboy를 `defParamCharset` 없이 만들어 한글 파일명이 깨져 들어오고, Supabase Storage는 비ASCII 키를 거부할 수 있다. 기존 프로필 업로드도 `${id}-${uuid}.${ext}`로 이 문제를 피한다. 표시용 원본 이름은 `Buffer.from(file.originalname, 'latin1').toString('utf8')`로 복원해 첨부 row의 `fileName`에 저장한다. `MilestoneAttachment`와 `MessageAttachment`에 똑같이 적용한다. 헬퍼는 `src/lib/storageKey.ts`(`buildStorageKey(folder, mimetype, originalname)`, `decodeOriginalName(originalname)`) 한 곳에 둔다.
- **손으로 쓰는 마이그레이션 SQL.** `@default(uuid())`와 `@updatedAt`은 Prisma 클라이언트가 채우는 값이고 DB 기본값이 아니다. 마이그레이션은 `"id" TEXT NOT NULL`을 기본값 없이 만든다. 백필 `INSERT`는 반드시 `id = gen_random_uuid()::text`, `"createdAt" = now()`, `"updatedAt" = now()`(해당 컬럼이 있으면)를 직접 넣는다. 로컬 PG 14와 CI PG 16 모두 `gen_random_uuid()`가 있다.
- **시드 삭제 순서.** FK가 `ON DELETE RESTRICT`이므로 스키마를 바꾸는 모든 커밋(P0, P1, P2-S, P3)은 `prisma/seed.js` 첫머리의 `deleteMany` 목록에 새 모델을 FK 역순(자식 먼저)으로 추가한다. 특히 마이그레이션이 백필 row를 넣는 P1(Milestone)과 P2-S(Conversation, ConversationParticipant)를 빠뜨리면 다음 `db:seed`가 P2003으로 실패한다.
- **Phase 종료 조건.** 모두 green이어야 커밋한다. 1~2는 각 워커가 자기 worktree에서 돌리고, 3~4는 통합 브랜치(`feat/platform-expansion`)에서 머지할 때마다 머지 담당이 돌린다. 단독 Phase는 워커가 곧 통합 브랜치에서 일하므로 넷 다 직접 돌린다.
  1. `workbridge-server`: `npm run typecheck`, `npx prisma validate`, `npm test`(전체)
  2. `workbridge-client`: `npm run build`, `npm run lint`
  3. 개발 DB에 `npx prisma migrate dev` 적용 후 `npm run db:seed` 성공(시드 스모크)
  4. 화면이나 프록시를 바꿨으면 `run-workbridge` 스킬로 띄우고 스크린샷을 직접 연다. 새 HTTP 메서드나 경로를 쓰는 화면이면 `curl`로 :3000 프록시를 거쳐 백엔드까지 닿는지도 확인한다.
  5. `docs/expansion/PROGRESS.md` 갱신, 이번 Phase의 결정을 `docs/expansion/DECISIONS.md`에 한 줄씩 추가. 오케스트레이터는 시작할 때 이 문서의 "결정" 소절들을 DECISIONS.md로 옮겨 둔다.
  6. 커밋 메시지는 한국어, 트레일러는 BRIEF.md "작업 방식"에 적힌 것을 쓴다. push하지 않는다.
- **병렬 워커 환경.** `.env`와 `.env.local`은 gitignore 대상이라 새 worktree에는 없다. 각 병렬 워커는 다음을 직접 만든다.
  - `git worktree add ../wb-<이름>`, 양쪽 패키지에서 `npm ci`(서버는 postinstall로 `prisma generate`).
  - 테스트 DB: `bash scripts/test-db.sh workbridge_test_<이름>`, 테스트는 `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/workbridge_test_<이름> npm test`. 공유하면 서로의 픽스처가 지워진다.
  - 개발 DB와 포트: 서버 `.env`는 통합 브랜치의 `.env`를 복사한 뒤 `DATABASE_URL`/`DIRECT_URL`을 `postgresql://$USER@localhost:5432/workbridge_dev_<이름>`(먼저 `createdb workbridge_dev_<이름>`)으로, `PORT`를 워커 번호에 맞춰(`4001`, `4002`, …), `CLIENT_URL`을 짝 포트(`http://localhost:3001`, …)로 바꾼다. 클라이언트 `.env.local`은 `API_URL`과 `NEXT_PUBLIC_API_URL`을 같은 서버 포트로 두고, `npx next dev -p 3001`처럼 포트를 직접 지정해 띄운다(`npm run dev`는 3000 고정). 워커끼리 개발 DB와 포트를 절대 공유하지 않는다.
  - 워커는 자기 개발 DB에서 `migrate dev`를 돌릴 수는 있지만 **새 마이그레이션을 만들지 않는다**(§3.1). 종료 조건 3~4의 공식 확인은 머지 후 통합 브랜치에서 한다.

---

## 1. 현재 상태 요약

### 1.1 규모 (2026-10-21, `feat/platform-expansion` @ 7a96fcd)

| 구역 | 파일 | 줄 수 | 측정 |
|---|---|---|---|
| 서버 `workbridge-server/src` | 28 (`.ts`) | **2,737** | `find src -type f \| xargs wc -l` |
| 클라이언트 `workbridge-client/src` | 55 (`.js/.jsx/.css`) | **4,727** | 같은 방식 |
| 제품 코드 합계 | | **7,464** | |
| 서버 테스트 `workbridge-server/test` | 18 | 12,519 | it/it.each/it.fails 679줄, 전개하면 약 1,057건, `it.fails` 54줄 |
| 시드 `prisma/seed.js` | 1 | 544 | CommonJS |
| 마이그레이션 | 10 | | `20260312030411_init` … `20260512003000_normalize_skill_taxonomy` |

서버 컨트롤러 가운데 큰 파일은 `projects.controller.ts` 560줄, `applications.controller.ts` 278줄, `auth.controller.ts` 259줄, `users.controller.ts` 252줄, `payments.controller.ts` 249줄이다.

### 1.2 모델 (9개, enum 5개)

`User`, `Project`, `ProjectBookmark`, `Application`, `Contract`, `Payment`, `Review`, `Notification`, `PricingAnalysis`.
Enum: `Role`, `ProjectStatus`(UPCOMING/OPEN/IN_PROGRESS/COMPLETED/CANCELLED/CLOSED), `ApplicationStatus`, `ContractStatus`(PENDING/ACTIVE/COMPLETED), `PaymentStatus`(PENDING/COMPLETED/REFUNDED/FAILED).

### 1.3 엔드포인트 (40개 + `/health`)

| 라우터 | 보호 | 공개 | 엔드포인트 |
|---|---|---|---|
| auth | 2 | 5 | signup, login, logout, refresh, select-role, google, google/callback |
| users | 5 | 2 | me (GET/PATCH), me/applications, me/bookmarks, me/projects, :id, :id/reviews |
| projects | 8 | 2 | 목록, 생성, 상세, 수정, 삭제, status, analyze, bookmark GET/POST/DELETE |
| applications (`/api/projects`에 중첩) | 3 | 0 | 지원, 지원자 목록, 수락/거절 |
| contracts | 3 | 0 | GET :id, POST :id/sign, PATCH :id(완료) |
| payments | 4 | 0 | 생성, confirm, dev-complete, 목록 |
| reviews | 1 | 1 | 작성, users/:id |
| notifications | 4 | 0 | 목록, unread-count, :id/read, read-all |

### 1.4 클라이언트 페이지 (21개 `page.jsx`, 프록시 라우트 8개)

`/`, `/login`, `/signup`, `/auth/callback`, `/auth/select-role`, `/projects`, `/projects/new`, `/projects/[id]`, `/projects/[id]/edit`, `/projects/[id]/applications`, `/projects/[id]/analysis`, `/contracts/[id]`, `/payments/[id]`(id = contractId), `/payments/result`, `/profile`, `/users/[id]`, `/my/applications`, `/my/bookmarks`, `/my/projects`, `/my/payments`, `/my/notifications`.
API 프록시는 두 갈래다. 일반 경로는 `app/api/[...path]/route.js`이고 `content-type`과 `authorization`만 넘기며 **GET/POST/PATCH/DELETE만 export한다(PUT 없음)**. 인증 경로(`app/api/auth/*/route.js`)는 `lib/server/authProxy.js`의 `proxyAuthRequest`를 쓰고 content-type, authorization, refresh 쿠키만 넘긴다. 브라우저에서 `lib/api.js`의 base URL은 `''`라서 모든 호출이 이 프록시를 거친다. 둘 다 Phase 0에서 고친다. "내 계약 목록" 페이지는 없다. 계약에는 지원/프로젝트 화면을 거쳐서만 들어간다.

### 1.5 확장이 바꾸는 기존 불변식과 동작

| # | 현재 | 확장 후 | 바뀌는 Phase |
|---|---|---|---|
| 1 | `Payment.contractId @unique`(계약↔결제 1:1), `Contract.payment Payment?` | 결제는 마일스톤 단위다. `Payment.milestoneId @unique`, `Contract.payments Payment[]`(1:N) | P1 |
| 2 | `POST /api/payments` body `{ contractId }`, 금액 = `contract.amount` | body `{ milestoneId }`, 금액 = `milestone.amount` | P1 |
| 3 | 계약 완료는 클라이언트의 `PATCH /api/contracts/:id {status:COMPLETED}`(결제 COMPLETED 필요) | 마지막 마일스톤 승인(수동/자동) 트랜잭션에서 자동 완료. `PATCH`는 **410** | P1 |
| 4 | `GET /api/contracts/:id`와 sign 응답에 `payment` 포함 | `payment` 키를 없애고 `milestones[]`(각각 `payment`, 최신 제출)와 `milestoneSummary`를 넣는다 | P1 |
| 5 | 지원 수락 트랜잭션은 5단계 | 6단계(기본 마일스톤 생성), P2A 이후 7단계(대화방 + 시스템 메시지) | P1, P2A |
| 6 | 서명 시 양측 서명이면 ACTIVE | 유효한 마일스톤 계획(합계 = 계약 금액)이 있어야 활성화되고, 활성화 시 양측에 `CONTRACT_ACTIVATED` 알림 | P1 |
| 7 | 알림 type 4종, 항상 인앱 row 생성 | 20여 종. 모든 생성이 `notify()`를 거치고 설정에 따라 인앱/이메일 | P0(헬퍼), P3(채널) |
| 8 | 규칙 7 "There is no cron" | 지연 스윕은 유지하고 10분 주기 예약 작업을 추가 | P0 |
| 9 | 규칙 1: errorHandler가 `console.error`로 500만 로깅 | 구조화 로거. error 레벨(`console.error`)은 여전히 500 한 번뿐이고, 접근 로그는 info(`console.log`) | P0 |
| 10 | 로그인/AI 분석 무제한 | 429 + `Retry-After` | P0 |
| 11 | `GET /api/users/:id` 응답 | `portfolioItems`, `careers`, `careerSummary` 추가(가산적) | P2B |
| 12 | 업로드는 이미지 전용, `profiles/` 폴더 고정 | 첨부 전용 미들웨어(문서/압축 허용, 10MB)와 폴더 인자 | P0 |

### 1.6 영향받는 기존 테스트와 명세 절

| 파일 / 절 | 이유 | Phase |
|---|---|---|
| `test/helpers/factories.ts` | `makePayment(contractId, …)` → `makePayment(milestoneId, …)`. `makeContractScenario`가 기본 마일스톤 1개를 만든다. 신규 팩토리 추가 | P1(+P2) |
| `test/helpers/db.ts` `TABLES` | 새 모델을 모두 truncate 목록에 넣는다(빠지면 픽스처가 새어 나간다) | 스키마를 바꾸는 모든 Phase |
| `test/payments.test.ts` (1,241줄) | 거의 전부: contractId → milestoneId, 상태표, confirm 부수효과(마일스톤 FUNDED), dev-complete. D13/D18/D14/D8 `it.fails`는 milestoneId 기준으로 다시 고정한다. "errorHandler logging" 블록의 500 벡터는 `{ milestoneId: 12345 }`로 바꾼다 | P1 |
| `test/contracts.test.ts` (793줄) | GET 포함 관계(payment → milestones), sign 활성화 조건과 알림, `PATCH` 블록 전체(→ 410 한 건, 완료 시나리오는 `milestones.test.ts`로 옮긴다), `failTransactionStep`의 `WATCHED_MODELS` | P1 |
| `test/applications.test.ts` | 수락 트랜잭션에 마일스톤 생성(P1), 대화방 생성(P2A) 단계가 추가된다. 롤백 테스트 확장 | P1, P2A |
| `test/authorization.test.ts` | `PROTECTED_ROUTES`(현재 30개), `ROLE_GATED_ROUTES`(14개), `PUBLIC_ROUTES`(10개) 개수 단언과 그 위의 라우터별 내역 주석, **`:581-582`의 "8 CLIENT-only / 6 FREELANCER-only" 분할 단언**, `Ids` 인터페이스와 `MISSING` 상수(신규 라우트용 `milestoneId`, `settlementId`, `conversationId`, `messageId`, `portfolioItemId`, `careerId` 필드 추가), payments 라우트 body(`milestoneId`), contracts PATCH(410), 신규 라우트 전부. 내부 작업 엔드포인트는 P0부터 `PUBLIC_ROUTES`에 들어간다(env 미설정 → 404) | 모든 Phase |
| `test/soft-delete.test.ts` | D12 행렬 `mutations`는 `it.fails.each`(`:464`)로 돈다. 그래서 (1) `POST /api/payments`, `/confirm` 행은 body를 `milestoneId`로 바꾸고 `it.fails`에 남긴다. (2) `PATCH /api/contracts/:id` 행은 P1에서 **`mutations`에서 빼낸다**. 410은 아무것도 쓰지 않고 ≥400이라 `it.fails`가 "예상 밖 통과"로 깨진다. 410 단언은 `contracts.test.ts`로 옮긴다. (3) 신규 라우트는 `requireActiveUser`로 통과해야 하므로 **별도 배열 `guardedMutations`를 만들고 `it.each`**로 돌린다(같은 `setup/send/assertUnchanged` 형식). (4) D21 `completeContract` 행은 `POST /api/milestones/:id/approve`를 대상으로 하는 통과 테스트로 바꾸고, D21의 `it.fails`는 get/sign 두 개만 남긴다 | 모든 Phase |
| `test/auth.test.ts`, `test/projects-write.test.ts` | 로그인/analyze 레이트 리밋이 기존 테스트 횟수에 걸리지 않는지 확인한다(테스트마다 DB를 truncate하므로 카운터도 초기화된다) | P0 |
| `test/users.test.ts` | 공개 프로필 응답 키 추가(정확한 키 집합을 단언하는 테스트가 있는지 확인) | P2B |
| `test/notifications.test.ts` | type 목록, 설정에 따른 인앱 억제 | P3 |
| BEHAVIOR.md 규칙 1, 5, 6, 7, 8 | 로깅, 신규 리소스의 소프트 삭제, 원자성 목록, 예약 작업, zod 메시지 형식 | P0, P1 |
| BEHAVIOR.md Applications(`PATCH …/applications/:appId`) | 수락 단계 추가 | P1, P2A |
| BEHAVIOR.md Contracts 전체, Payments 전체 | 다시 쓴다 | P1 |
| BEHAVIOR.md Notifications "`type` is one of 4" 문장 | P1이 신규 type 14개를 쓰기 시작하므로 **P1에서** 목록을 넓힌다(정책 표 링크로 대체). 설정과 이메일은 P3 | P1, P3 |
| BEHAVIOR.md 규칙 3의 예시(`PATCH /api/contracts/:id`에 잘못된 status + 없는 id → 400)와 **Q15** | 그 라우트가 항상 410이 되므로 예시를 다른 엔드포인트로 바꾸고(예: `PATCH /api/projects/:projectId/applications/:appId`의 잘못된 status) Q15 본문도 고친다 | P1 |
| BEHAVIOR.md "Note on validTransitions" | `completeContract`를 언급한다. "approving the last milestone"으로 고친다 | P1 |
| BEHAVIOR.md Auth `POST /login`, Projects `POST /:id/analyze` | 429 | P0 |
| BEHAVIOR.md Users `GET /:id` | 응답 확장 | P2B |
| BEHAVIOR.md D12, D13, D18, D21, Q5, "Suggested test priority" | 결제/완료 경로가 바뀐 만큼 문구를 고친다(번호와 해결 여부는 유지) | P1 |
| `src/types/index.ts`의 "9 public routes" 주석, CLAUDE.md의 같은 문장 | 내부 작업 엔드포인트가 JWT 없이 열리므로 **P0에서** 고치고(10개), P2B에서 공개 GET 2개를 더해 다시 고친다(12개) | P0, P2B |

---

## 2. 도메인별 설계

### 2.0 인프라 (Phase 0)

#### 2.0.1 Prisma 모델

```prisma
enum JobStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED      // maxAttempts 소진 또는 PermanentJobError
  CANCELLED
}

model Job {
  id          String    @id @default(uuid())
  type        String                       // TS union `JobType` (src/jobs/types.ts). Notification.type과 같은 방식
  payload     Json      @default("{}")
  status      JobStatus @default(PENDING)
  runAt       DateTime  @default(now())
  attempts    Int       @default(0)
  maxAttempts Int       @default(5)
  lockedAt    DateTime?
  lockedBy    String?                      // 워커 id: `${hostname}:${pid}:${random}`
  lastError   String?
  dedupeKey   String?   @unique            // 같은 키는 한 번만 enqueue
  traceId     String?                      // enqueue한 요청의 requestId
  completedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([status, runAt])
  @@index([type, status])
}

model RateLimitCounter {
  key         String
  windowStart DateTime
  count       Int      @default(0)
  expiresAt   DateTime

  @@id([key, windowStart])
  @@index([expiresAt])
}
```

마이그레이션 이름은 `expansion_job_queue_rate_limit`이다. FK가 없는 테이블이지만 시드가 Job row를 넣으므로(P4) 같은 커밋에서 `seed.js`의 `deleteMany`에 `job`, `rateLimitCounter`를 추가한다.

#### 2.0.2 작업 큐 동작

- **enqueue**: `enqueueJob(client: PrismaTransactionClient, { type, payload, runAt?, dedupeKey?, maxAttempts? })`. 도메인 트랜잭션 안에서 호출해 상태 변경과 작업 생성을 원자적으로 묶는다(transactional outbox). 내부 구현은 `createMany({ data: [row], skipDuplicates: true })`이므로 같은 `dedupeKey`가 이미 있으면 아무것도 하지 않는다. `traceId`는 AsyncLocalStorage의 요청 컨텍스트에서 채운다.
- **claim**: `$queryRaw`로 아래 쿼리를 실행한다. 워커가 여러 개여도 안전하다.
  ```sql
  UPDATE "Job" SET status='RUNNING', "lockedAt"=$now, "lockedBy"=$worker, attempts=attempts+1, "updatedAt"=$now
  WHERE id IN (SELECT id FROM "Job" WHERE status='PENDING' AND "runAt" <= $now
               ORDER BY "runAt", "createdAt" LIMIT $limit FOR UPDATE SKIP LOCKED)
  RETURNING *;
  ```
- **실행**: `registry[type](ctx)`. `ctx = { job, payload, now, logger }`. 핸들러는 **멱등**이어야 하고, 실행 시점의 DB 상태를 다시 확인한 뒤 조건부 `updateMany`로 쓴다.
- **성공**: `SUCCEEDED`, `completedAt`.
- **반복 작업의 다음 회차**: 성공 시점이 아니라 **claim 시점에** 다음 회차를 enqueue한다(dedupeKey로 중복 방지). 그래서 한 회차가 재시도 끝에 FAILED가 되어도 주간 체인이 끊기지 않는다.
- **실패**: `PermanentJobError`면 바로 `FAILED`. 그 밖의 오류는 `attempts < maxAttempts`이면 `PENDING`으로 되돌리고 `runAt = now + min(30s × 2^(attempts-1), 1h)`, `lastError`를 기록한다. 소진되면 `FAILED`로 두고 error 레벨로 로그를 남긴다.
- **stale lock 회수**: `recoverStaleJobs(now)`는 `RUNNING`이고 `lockedAt < now - 10분`인 작업을 `PENDING`으로 되돌린다. 매 폴링 시작 시 실행한다.
- **진입점 3개**
  1. `runDueJobs({ now = new Date(), limit = 50, types? }): Promise<{ claimed, succeeded, retried, failed }>`(`src/jobs/runner.ts`). 테스트, CLI, 내부 엔드포인트가 모두 이것을 부른다. `runDueJobs` 자체는 `ensureRecurringJobs`를 부르지 않는다. 테스트가 반복 작업 row를 원치 않을 수 있어서다. 대신 **운영 경로가 되는 진입점 2~4는 모두 `ensureRecurringJobs(now)`를 먼저 부르고** `runDueJobs`를 부른다. 그렇지 않으면 운영(워커 없음)에서 주간 정산과 스윕이 처음부터 생기지 않는다.
  2. **개발용 폴링 워커** `startJobWorker()`(`src/jobs/worker.ts`). `index.ts`의 `app.listen` 블록 안(`!isProduction && NODE_ENV !== 'test'`)에서 `JOB_WORKER_ENABLED !== 'false'`일 때 시작한다. 시작 시 `ensureRecurringJobs(now)`를 한 번 부르고, `JOB_POLL_INTERVAL_MS`(기본 5000)마다 `recoverStaleJobs` → `runDueJobs`를 실행한다. SIGTERM/SIGINT에서는 현재 배치를 끝내고 멈춘다.
  3. **CLI** `npm run jobs:run`(= `tsx src/jobs/cli.ts --once`)은 ensureRecurring + 한 번 실행하고 결과를 출력한다. `npm run jobs:worker`(`tsx src/jobs/cli.ts`)는 단독 워커다. CLI가 `src/` 안에 있어야 typecheck 대상에 들어간다.
  4. **내부 엔드포인트** `POST /api/internal/jobs/run`(`routes/internal.routes.ts`, `controllers/internal.controller.ts`). `X-Internal-Token` 헤더가 env `INTERNAL_JOB_TOKEN`과 일치해야 한다. 비교는 양쪽의 **SHA-256 다이제스트**를 `crypto.timingSafeEqual`로 한다. 원문을 바로 넣으면 길이가 다를 때 RangeError가 나서 500이 된다. 헤더가 없어도 빈 문자열로 해시해 403으로 처리한다. env가 없으면 **404**(엔드포인트 존재를 숨긴다), 토큰이 틀리면 403이다. body `{ limit? }`(zod). 처리 순서는 `ensureRecurringJobs(now)` → `recoverStaleJobs(now)` → `runDueJobs`이고 응답은 `runDueJobs` 결과다. JWT 인증은 쓰지 않으므로 authorization 테스트의 공개 라우트 표에 **P0부터** 들어간다.
- **반복 작업 정의** `src/jobs/recurring.ts`. 각 항목은 `{ type, nextRunAt(now): Date, dedupeKey(runAt) }`이다.

| type | 주기 | dedupeKey | 하는 일 | 추가 Phase |
|---|---|---|---|---|
| `project.lifecycleSweep` | 10분(정각 기준 슬롯) | `project.lifecycleSweep:<slotISO>` | `closeExpiredOpenProjects(ctx.now)` | P0 |
| `maintenance.cleanup` | 매일 04:00 KST | `maintenance.cleanup:<YYYY-MM-DD>` | 14일 지난 SUCCEEDED/CANCELLED Job과 만료된 RateLimitCounter 삭제 | P0 |
| `settlement.weeklyBatch` | 매주 월 03:00 KST | `settlement.weeklyBatch:<periodStartISO>` | §2.1 정산 배치 | P1 |

- **`closeExpiredOpenProjects`의 시각 인자**: 지금은 함수 안에서 `new Date()`를 쓴다. P0에서 선택 인자 `now: Date = new Date()`를 **가산적으로** 추가한다. 기존 호출부는 인자 없이 그대로 두고, 예약 작업 핸들러만 `ctx.now`를 넘긴다. 그래야 스윕 작업 테스트가 결정적이다.
- **`closeExpiredOpenProjects` 결정**: **지연 호출을 그대로 두고 예약 작업을 추가한다.** 근거는 셋이다. (1) 규칙 7과 기존 테스트가 "`GET /api/projects`가 row를 쓴다"를 명시적으로 단언하고, BRIEF가 이 부채를 고치지 말라고 한다. (2) 운영(Vercel 서버리스)에는 상시 워커가 없어서 지연 호출이 유일한 보장이다. (3) 함수가 멱등이라 둘이 같이 돌아도 결과가 같다. 예약 작업은 트래픽이 없어도 상태와 지원서 거절을 최신으로 유지하는 보조 수단이다. 규칙 7을 "There is no cron"에서 "lazy sweep on read paths **and** a scheduled sweep every 10 minutes when a worker runs"로 고친다.

#### 2.0.3 로깅과 요청 ID

- `src/lib/logger.ts`: 의존성 없는 JSON 라인 로거. `{ time, level, msg, requestId?, jobId?, ...fields }` 형식이다. **error 레벨만 `console.error`**로, debug/info/warn은 `console.log`로 내보낸다. 기존 테스트 "logs a 500 exactly once"가 `console.error` spy로 단언하기 때문이다. `LOG_LEVEL`(debug|info|warn|error|silent, 기본 info, vitest env에서는 `error`).
- `src/lib/requestContext.ts`: `AsyncLocalStorage<{ requestId, userId? }>`. 로거, `enqueueJob`의 `traceId`, 작업 실행 컨텍스트(`jobId`)가 여기서 값을 읽는다.
- `src/middlewares/requestId.ts`: 들어온 `X-Request-Id`가 `/^[A-Za-z0-9._-]{1,128}$/`에 맞으면 그대로 쓰고 아니면 uuid v4를 새로 만든다. 응답 헤더 `X-Request-Id`에 항상 넣는다. **에러 본문에는 넣지 않는다**(규칙 1의 envelope은 정확히 `{error:{message}}`).
- `src/middlewares/accessLog.ts`: `res.on('finish')`에서 `info`로 method, path(쿼리 제외), status, durationMs, userId를 남긴다. **상태 코드와 상관없이 info**로 남긴다(500도 info). error 레벨 로그는 errorHandler 한 곳에서만 나온다.
- `errorHandler`: `console.error(err)`를 `logger.error('unhandled error', { err })`로 바꾼다. "500만, 정확히 한 번" 규칙은 유지한다. D14(Prisma 메시지 노출)는 고치지 않는다.
- **오류 직렬화**: `Error`의 `name`, `message`, `stack`은 열거 불가능한 속성이라 그대로 `JSON.stringify`하면 `"err":{}`가 된다. 로거는 필드 값이 `Error`(또는 `instanceof Error`가 아닌 객체 중 `message`/`stack`을 가진 것)이면 `{ name, message, stack, code, statusCode }`로 명시적으로 펼친다. Prisma 오류의 `code`(P2002 등)와 `meta`도 포함한다. `serializeError`를 `logger.ts`에서 export하고 `lib.test.ts`(또는 `logger.test.ts`)에서 단언한다.
- **프록시 두 곳을 모두 고친다** (클라이언트, P0)
  - `app/api/[...path]/route.js`: `x-request-id`와 `x-forwarded-for`(들어온 헤더가 있으면 그 뒤에 `request.ip`를 붙이고, 없으면 `request.ip`)를 백엔드로 넘기고, 응답의 `x-request-id`와 `retry-after`를 복사한다. **`export async function PUT`을 추가한다.** 지금은 GET/POST/PATCH/DELETE만 있어서, 브라우저에서 나가는 PUT(마일스톤 계획, 지급 계좌, 포트폴리오 순서, 알림 설정)이 전부 Next에서 405가 된다. 클라이언트에는 테스트가 없고 build/lint로도 잡히지 않는다.
  - `lib/server/authProxy.js` `proxyAuthRequest`: 로그인/회원가입/refresh는 catch-all이 아니라 이 함수로 간다. 같은 방식으로 `x-forwarded-for`, `x-request-id`를 넘기고 응답의 `x-request-id`, `retry-after`를 복사한다. 이것을 빼면 모든 브라우저 로그인이 Next 서버 IP(127.0.0.1) 하나로 세어져 IP별 로그인 제한이 "사이트 전체 15분에 20회"가 되고, 여러 시드 계정으로 로그인하는 시연 녹화가 걸린다.
- 서버는 `TRUST_PROXY`가 설정됐을 때만 `app.set('trust proxy', env.TRUST_PROXY)`를 건다. `workbridge-server/.env.example`과 `run-workbridge` 스킬의 `.env` 템플릿에 `TRUST_PROXY=loopback`을 넣는다. 로컬에서 Next(:3000)가 같은 머신에서 프록시하므로 loopback만 신뢰하면 `req.ip`가 `X-Forwarded-For`의 실제 브라우저 IP가 된다. 테스트(supertest)는 헤더 없이 직접 붙으므로 `req.ip`가 그대로 루프백이다.
- **P0 종료 시 추가 확인**: 서버와 클라이언트를 띄우고 `curl -i -X PUT http://localhost:3000/api/notifications/preferences -H 'Authorization: Bearer <token>'`이 Next의 405가 아니라 백엔드의 응답(이 시점에는 라우트가 없으므로 Express의 404)이 되는지, 그리고 응답에 `x-request-id`가 붙는지 확인한다. `/api/auth/login`을 거친 요청의 서버 접근 로그 `ip`가 127.0.0.1이 아닌지도 본다.

#### 2.0.4 입력 검증 (zod)

- 의존성 `zod@^3`. `src/middlewares/validate.ts`의 `validate({ body?, query?, params? })`는 실패하면 `AppError(\`${path}: ${issue.message}\`, 400)`를 던진다. 첫 이슈만 쓰고, 경로가 없으면 메시지만 쓴다. 파싱된 값은 `req.body`/`res.locals.query`에 둔다. Express 4의 `req.query`는 재할당하지 않는다.
- 신규 도메인의 쿼리 규칙(BEHAVIOR 규칙 12로 명세): 빈 문자열은 "없음"으로 보고 기본값을 쓴다. 반복 파라미터(배열), 소수, 뒤에 문자가 붙은 숫자는 **400**이다. 기존 엔드포인트의 Q12/Q13 동작은 건드리지 않는다.
- multipart 라우트는 multer 다음에 `validate`를 둔다. multer가 body를 채운 뒤에 검증해야 하기 때문이다.

#### 2.0.5 레이트 리밋

- `src/lib/rateLimit.ts`의 `hit(key, windowMs, limit, now)`는 `INSERT … ON CONFLICT ("key","windowStart") DO UPDATE SET count = count + 1 RETURNING count`(고정 윈도)로 동작하고 `{ allowed, remaining, retryAfterSec }`를 돌려준다. `peek()`와 `reset(key)`도 둔다. 서버리스에서도 맞게 동작하도록 Postgres를 쓴다.
- `src/middlewares/rateLimit.ts`의 `rateLimit({ name, windowMs, limit, key(req) })`는 초과하면 `res.set('Retry-After', n)` 후 `AppError('Too many requests. Try again later.', 429)`를 던진다. `RATE_LIMIT_ENABLED === 'false'`면 통과시킨다(env는 요청마다 평가한다).
- **로그인** (BEHAVIOR Auth `/login`에 추가)
  - IP 기준: 15분에 20회(결과와 무관) → 429. 미들웨어로 막는다. 키의 IP는 Express `req.ip`다. `TRUST_PROXY`가 설정되면 신뢰한 프록시를 뺀 `X-Forwarded-For`의 클라이언트 IP, 아니면 소켓 주소다. 규칙 10에 이 정의를 그대로 적는다.
  - 이메일+IP 기준 **실패** 5회/15분 → 429. 미들웨어는 `peek`만 하고, 컨트롤러가 401을 던지기 직전에 `hit`, 성공하면 `reset`한다. 존재하지 않는 이메일도 똑같이 센다. 그래서 계정 열거에 쓸 수 없다(기존 "indistinguishable" 규칙 유지). 키에 넣는 이메일은 `trim().toLowerCase()`한다. 저장된 이메일 정규화(Q16)는 건드리지 않는다.
  - 근거: 크리덴셜 스터핑 방어의 보편적 기본값이고, 성공 시 리셋해서 정상 사용자의 오타 몇 번은 문제가 되지 않는다.
- **AI 단가 분석** `POST /api/projects/:id/analyze`: `authenticate → requireRole('CLIENT') → rateLimit` 순서다. 사용자당 1시간 5회, 하루(KST 자정 기준) 20회. 404/403/502로 끝난 호출도 센다. 근거: OpenAI 비용은 요청 시점에 생기고, 미들웨어가 결과를 알 수 없다.
- 테스트: `RateLimitCounter`를 `TABLES`에 넣으므로 테스트마다 초기화된다. vitest env `RATE_LIMIT_ENABLED: 'true'`.

#### 2.0.6 기타 인프라 산출물

- `src/middlewares/activeUser.ts`의 `requireActiveUser`: `prisma.user.findFirst({ where: { id: req.user.id, deletedAt: null }, select: { id: true } })`가 없으면 401 `Account is no longer active`. 신규 라우트 전용이다.
- `src/middlewares/attachmentUpload.ts`: 공통 팩토리 `createUpload({ fieldName, maxFiles, maxBytes, allow(mimetype) })`가 multer memoryStorage 인스턴스를 만들고, multer 오류와 필터 거부를 직접 감싸서 **413**(크기, `LIMIT_FILE_SIZE`), **400**(형식, 개수, 예상 밖 필드)인 `AppError`로 바꾼다. 여기서 두 가지를 export한다.
  - `attachmentUpload`(`files`, 최대 5개, 파일당 10MB): 허용 MIME은 `image/*`, `application/pdf`, `application/zip`, `application/x-zip-compressed`, `text/plain`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`, `application/x-hwp`.
  - `imageUpload`(`image`, 1개, 5MB, `image/*`만): 포트폴리오 이미지용. 기존 `upload`와 제한은 같지만 오류 처리가 다르다.
  신규 도메인에서는 D6가 생기지 않는다. 기존 `upload`는 그대로 둔다(의도된 혼재).
- **요청 본문 크기와 Vercel**: 로컬에서는 10MB × 5개가 그대로 동작한다. Vercel 서버리스 함수의 요청 본문 한도는 4.5MB라서 운영에서는 큰 첨부가 플랫폼 단에서 413으로 막힌다. 코드로 우회하지 않고 P4에서 `docs/DEPLOYMENT.md`에 한계로 적는다(직접 업로드 + signed upload URL은 열린 질문 Q21과 함께 나중에).
- `src/lib/notifications/notify.ts`(최소판): `notify(client, { userId, type, title, message, href })`, `notifyMany(client, rows[])`는 지금은 `Notification` row만 만든다. P3에서 설정과 이메일을 붙인다. P1~P2의 신규 코드는 처음부터 이 헬퍼를 쓴다.
- `src/types/index.ts`: `NotificationType` union을 `src/lib/notifications/types.ts`로 옮기고 re-export한다. `JobType`, `JobHandler`, `RateLimitRule` 타입을 추가한다.
- 문서 동기화(P0): 내부 작업 엔드포인트가 JWT 없이 열리므로 `src/types/index.ts`의 "9 public routes" 주석과 공개 핸들러 목록, `CLAUDE.md`의 같은 문장을 10개로 고치고 `internal.controller`가 `req.user`를 읽지 않는다고 적는다.
- `src/env.ts`: `LOG_LEVEL`, `TRUST_PROXY`, `RATE_LIMIT_ENABLED`, `INTERNAL_JOB_TOKEN`, `JOB_WORKER_ENABLED`, `JOB_POLL_INTERVAL_MS`를 optional/defaulted getter로 추가한다. 이후 Phase에서 `MILESTONE_AUTO_APPROVE_DAYS`(기본 '7'), `EMAIL_PROVIDER`(기본 'log'), `EMAIL_FROM`(기본 'WorkBridge <no-reply@workbridge.local>')을 더한다.
- `vitest.config.ts` env: `LOG_LEVEL: 'error'`, `RATE_LIMIT_ENABLED: 'true'`, `JOB_WORKER_ENABLED: 'false'`.
- 테스트 헬퍼 `test/helpers/jobs.ts`: `runJobs(now)`(= `runDueJobs({ now })`), `jobsOf(type)`, `atDaysFromNow(n)`.

#### 2.0.7 엔드포인트

| Method | Path | 역할 | 동작 | 파일 |
|---|---|---|---|---|
| POST | `/api/internal/jobs/run` | 내부 토큰 | 실행 시점이 된 작업을 한 번 실행한다. env 미설정 404, 토큰 불일치 403 | 신규 `internal.routes.ts` / `internal.controller.ts` |
| POST | `/api/auth/login` | 공개 | (변경) 429 | 기존 `auth.routes.ts`, `auth.controller.ts` |
| POST | `/api/projects/:id/analyze` | CLIENT | (변경) 429 | 기존 `projects.routes.ts` |

#### 2.0.8 결정

- 큐는 Postgres 테이블과 `FOR UPDATE SKIP LOCKED` 폴링으로 만든다. 외부 브로커 없이 BRIEF의 "로컬 전용" 조건을 지킨다.
- `Job.type`은 enum 대신 String + TS union으로 둔다. 타입을 추가할 때 마이그레이션이 필요 없고, `Notification.type`과 관례가 같다.
- 테스트는 워커를 띄우지 않고 `runDueJobs({ now })`를 직접 부른다.
- 로거는 pino 대신 자체 JSON 로거로 만든다. 기존 `console.error` spy 테스트의 의미를 유지하고 의존성을 늘리지 않는다.
- 레이트 리밋은 메모리가 아니라 Postgres에 둔다. 서버리스 인스턴스 사이에서 카운트를 공유해야 한다.
- 지연 스윕은 유지하고 예약 스윕을 추가한다(근거는 위).
- 운영 환경의 작업 실행 주체는 정하지 않는다(오케스트레이터 확정, §6.1-1). 내부 엔드포인트와 CLI만 두고, 둘 다 `ensureRecurringJobs`를 먼저 부르므로 나중에 외부 스케줄러를 붙이기만 하면 반복 작업이 생긴다.
- 반복 작업의 다음 회차는 claim 시점에 enqueue한다. 한 회차가 실패해도 체인이 끊기지 않는다.
- 내부 토큰은 SHA-256 다이제스트끼리 비교한다.
- 클라이언트 프록시 두 곳(catch-all, authProxy)이 PUT과 `X-Forwarded-For`/`X-Request-Id`를 다루게 하고, 서버는 `TRUST_PROXY=loopback`일 때 그 IP를 믿는다.
- 신규 업로드는 `attachmentUpload`/`imageUpload`만 쓰고, 저장 키는 `<folder>/<uuid>.<ext>`이며 원본명은 latin1→utf8로 복원해 DB에만 저장한다.

#### 2.0.9 규모 추정

서버 약 1,650줄, 클라이언트 약 70줄(프록시 두 곳, PUT 핸들러), 테스트 약 1,150줄(`jobs.test.ts`, `rate-limit.test.ts`, `request-id.test.ts`, `validate.test.ts`, `uploads.test.ts`(413/400, 파일명 복원), logger 직렬화, authorization 공개 라우트 표, soft-delete `guardedMutations` 골격).

---

### 2.1 마일스톤과 정산 (Phase 1)

#### 2.1.1 Prisma 모델

```prisma
enum MilestoneStatus {
  PENDING              // 계획됨, 미결제
  FUNDED               // 결제 완료(에스크로 보관), 작업 중
  SUBMITTED            // 산출물 제출, 검수 대기
  REVISION_REQUESTED   // 반려됨, 재제출 대기
  APPROVED             // 승인(수동/자동), 정산 대상
}

enum ApprovalType {
  MANUAL
  AUTO
}

enum SubmissionDecision {
  APPROVED
  REJECTED
}

enum SettlementStatus {
  SCHEDULED    // 배치가 집계함, 지급일 대기
  PROCESSING   // 지급 처리 중
  PAID
  FAILED       // 지급 실패(재시도 대기 또는 최종)
  ON_HOLD      // 지급 계좌 없음
}

model Contract {
  // 기존 필드 유지. 아래만 변경/추가
  completedAt DateTime?
  milestones      Milestone[]
  payments        Payment[]          // 기존 `payment Payment?` 대체
  settlementItems SettlementItem[]
}

model Milestone {
  id            String          @id @default(uuid())
  contractId    String
  contract      Contract        @relation(fields: [contractId], references: [id])
  sequence      Int                               // 1부터 시작
  title         String
  description   String?
  amount        Float                             // 원 단위 정수 값만 저장
  dueDate       DateTime                          // 해당 KST 날짜의 23:59:59.999
  status        MilestoneStatus @default(PENDING)
  fundedAt      DateTime?
  submittedAt   DateTime?                         // 최신 제출 시각
  autoApproveAt DateTime?                         // SUBMITTED일 때만 값이 있음
  approvedAt    DateTime?
  approvalType  ApprovalType?
  revisionCount Int             @default(0)
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt

  payment        Payment?
  submissions    MilestoneSubmission[]
  settlementItem SettlementItem?

  @@unique([contractId, sequence])
  @@index([status, autoApproveAt])
}

model MilestoneSubmission {
  id             String              @id @default(uuid())
  milestoneId    String
  milestone      Milestone           @relation(fields: [milestoneId], references: [id])
  round          Int                                // 1, 2, 3 …
  message        String
  links          String[]
  decision       SubmissionDecision?                // null = 검수 대기
  decisionReason String?                            // 반려 사유
  decidedAt      DateTime?
  decidedById    String?                            // 자동 승인이면 null
  autoDecided    Boolean             @default(false)
  submittedAt    DateTime            @default(now())

  attachments MilestoneAttachment[]

  @@unique([milestoneId, round])
}

model MilestoneAttachment {
  id           String              @id @default(uuid())
  submissionId String
  submission   MilestoneSubmission @relation(fields: [submissionId], references: [id])
  url          String
  fileName     String
  mimeType     String
  size         Int
  createdAt    DateTime            @default(now())

  @@index([submissionId])
}

model Payment {
  id          String        @id @default(uuid())
  contractId  String                              // @unique 제거
  contract    Contract      @relation(fields: [contractId], references: [id])
  milestoneId String        @unique               // 신규: 마일스톤과 1:1
  milestone   Milestone     @relation(fields: [milestoneId], references: [id])
  clientId    String
  client      User          @relation("ClientPayments", fields: [clientId], references: [id])
  amount      Float
  status      PaymentStatus @default(PENDING)
  paymentKey  String?
  orderId     String        @unique
  createdAt   DateTime      @default(now())

  @@index([contractId])
}

model SettlementItem {
  id           String      @id @default(uuid())
  milestoneId  String      @unique
  milestone    Milestone   @relation(fields: [milestoneId], references: [id])
  contractId   String
  contract     Contract    @relation(fields: [contractId], references: [id])
  freelancerId String
  freelancer   User        @relation("FreelancerSettlementItems", fields: [freelancerId], references: [id])
  settlementId String?                           // null = 미정산(다음 배치 대상)
  settlement   Settlement? @relation(fields: [settlementId], references: [id])
  grossAmount  Float
  feeRateBps   Int                               // 스냅샷. 1000 = 10%
  feeAmount    Float
  feeVatAmount Float
  netAmount    Float
  approvedAt   DateTime
  createdAt    DateTime    @default(now())

  @@index([freelancerId, settlementId])
  @@index([settlementId])
}

model Settlement {
  id                  String           @id @default(uuid())
  freelancerId        String
  freelancer          User             @relation("FreelancerSettlements", fields: [freelancerId], references: [id])
  periodStart         DateTime                    // 월 00:00 KST
  periodEnd           DateTime                    // 다음 월 00:00 KST(미포함)
  scheduledPayoutAt   DateTime                    // periodEnd + 2일 10:00 KST(= 그 주 수요일 10:00)
  status              SettlementStatus @default(SCHEDULED)
  itemCount           Int
  grossAmount         Float
  feeAmount           Float
  feeVatAmount        Float
  netAmount           Float
  payoutAttempts      Int              @default(0)
  bankName            String?                     // PROCESSING 진입 시 스냅샷
  accountNumberMasked String?
  accountHolder       String?
  providerReference   String?
  failureReason       String?
  paidAt              DateTime?
  createdAt           DateTime         @default(now())
  updatedAt           DateTime         @updatedAt

  items SettlementItem[]

  @@unique([freelancerId, periodStart])
  @@index([status, scheduledPayoutAt])
}

model PayoutAccount {
  id            String   @id @default(uuid())
  userId        String   @unique
  user          User     @relation(fields: [userId], references: [id])
  bankCode      String                              // lib/banks.ts의 코드
  accountNumber String                              // 숫자만. API 응답에서는 항상 마스킹
  holderName    String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

`User`에 역관계 `settlementItems`, `settlements`, `payoutAccount`를 추가한다.

**마이그레이션 `expansion_milestones_settlements`는 데이터 백필이 필요하다.** `npx prisma migrate dev --create-only --name expansion_milestones_settlements`로 만든 뒤 SQL을 손으로 고친다.
1. 새 테이블과 enum을 만들고 `Payment.milestoneId`를 **nullable**로 추가한다.
2. 계약마다 기본 마일스톤을 INSERT한다: `id=gen_random_uuid()::text`, `sequence=1`, `title='전체 작업'`, `amount=ROUND(contract.amount)`, `dueDate=contract.endDate`, `"createdAt"=now()`, `"updatedAt"=now()`(`@updatedAt`은 DB 기본값이 없어서 직접 넣어야 NOT NULL을 지킨다, §0). status는 계약이 COMPLETED면 `APPROVED`(`approvalType='MANUAL'`, `approvedAt=now()`), 결제가 COMPLETED면 `FUNDED`(`fundedAt=payment.createdAt`), 그 밖에는 `PENDING`이다. 기존 PENDING/FAILED 결제의 `amount`도 `ROUND`한 마일스톤 금액으로 맞춘다(소수 금액은 결제 페이지의 `parseInt(amount)`와 confirm의 `!==` 비교 때문에 영원히 결제할 수 없다).
3. `UPDATE "Payment" SET "milestoneId" = (해당 계약의 sequence 1 마일스톤)`.
4. `milestoneId`를 NOT NULL로 바꾸고 UNIQUE를 걸고 `contractId` UNIQUE를 없앤다.
5. `Contract.completedAt`은 `status='COMPLETED'`인 계약에 `createdAt`을 넣는다(정확한 값을 알 수 없어서 근사한다).
과거 완료 계약의 `SettlementItem`은 백필하지 않는다. 정산 원장은 확장 이후 승인분부터 시작한다(DATABASE.md에 적는다).
같은 커밋에서 `prisma/seed.js`의 `deleteMany` 목록에 `settlementItem`, `settlement`, `payoutAccount`, `milestoneAttachment`, `milestoneSubmission`, `payment`(기존), `milestone`을 FK 역순으로 넣는다(§0 "시드 삭제 순서").

#### 2.1.2 상태 기계

**Milestone**

| From | To | 트리거 | 주체 |
|---|---|---|---|
| (생성) | PENDING | 지원 수락 시 기본 1개, 또는 `PUT /contracts/:id/milestones` | 시스템 / 클라이언트 |
| PENDING | (삭제) | `PUT /contracts/:id/milestones`가 계획을 통째로 교체(계약 PENDING일 때만) | 클라이언트 |
| PENDING | FUNDED | 결제 confirm 성공 또는 dev-complete | 클라이언트(결제) |
| FUNDED | SUBMITTED | `POST /milestones/:id/submissions` | 프리랜서 |
| REVISION_REQUESTED | SUBMITTED | 재제출(round + 1) | 프리랜서 |
| SUBMITTED | APPROVED (MANUAL) | `POST /milestones/:id/approve` | 클라이언트 |
| SUBMITTED | REVISION_REQUESTED | `POST /milestones/:id/reject` (사유 필수) | 클라이언트 |
| SUBMITTED | APPROVED (AUTO) | `milestone.autoApprove` 작업. `autoApproveAt <= now`이고 round가 일치할 때 | 시스템 |

APPROVED는 종단 상태다. 모든 전이는 `updateMany({ where: { id, status: <기대 상태> } })`로 쓴다. **요청이 직접 일으키는 전이**(제출, 승인, 반려, 계획 교체)는 `count === 0`이면 **409**를 낸다. 수동 승인과 자동 승인이 경합해도 하나만 이긴다.

**예외: `PENDING → FUNDED`(`markFunded`)는 `count === 0`이어도 던지지 않고 no-op으로 끝난다.** 이 전이는 기존 `confirmPayment`의 `try { Toss 호출 + DB 쓰기 } catch (tossError) { payment FAILED; 400 }` 블록 안에서 일어난다. 여기서 409를 던지면 catch가 그것을 "검증 실패"로 바꿔 결제를 FAILED로 덮어쓴다. D18 경쟁(두 confirm이 모두 PENDING 검사를 통과)에서 지는 쪽이 이기는 쪽의 COMPLETED 결제를 FAILED로 되돌리고 마일스톤만 FUNDED로 남는 상태가 된다. D18 `it.fails`(`payments.test.ts:800`)는 계속 "실패"하므로 스위트가 이를 잡지 못한다. 그래서 `markFunded(tx, milestoneId, now)`는 조건부 update 결과가 0이면 알림과 작업 enqueue도 건너뛰고 `{ funded: false }`를 돌려준다. confirm 경로의 나머지 구조(catch-all, D8, D18)는 고치지 않는다. 대신 P1 명세의 confirm 절에 다음 문장을 넣는다: "If any database write after the provider has captured the payment fails (including notification or job enqueue), the payment is marked FAILED and the response is 400 — existing behaviour of the D8 family, not a new divergence." 같은 `markFunded`를 dev-complete도 쓴다.

**Contract** (기존 표에 추가): `ACTIVE → COMPLETED`는 마지막 마일스톤이 APPROVED가 되는 같은 트랜잭션에서 일어나고 `completedAt`을 기록한다. 이때 프로젝트도 `COMPLETED`가 된다. Q5의 `CLOSED → COMPLETED` 우회는 기존과 같고, Q5는 열린 채로 둔다.

**Settlement**

| From | To | 트리거 |
|---|---|---|
| (없음) | SCHEDULED | `settlement.weeklyBatch`가 프리랜서별 미정산 항목을 묶어 생성. `settlement.payout`을 `scheduledPayoutAt`에 enqueue |
| SCHEDULED | PROCESSING | `settlement.payout` 실행 + 지급 계좌 있음. 계좌 스냅샷 저장, `payoutAttempts += 1` |
| SCHEDULED | ON_HOLD | `settlement.payout` 실행 + 지급 계좌 없음. `SETTLEMENT_ON_HOLD` 알림. `payoutAttempts`는 늘리지 않는다 |
| ON_HOLD | SCHEDULED | `PUT /users/me/payout-account` 성공. `scheduledPayoutAt` = 다음 수요일 10:00 KST(지금이 수요일 10:00 전이면 오늘)로 다시 잡고 payout 작업을 enqueue. dedupeKey에 새 `scheduledPayoutAt`이 들어가므로 원래 작업과 겹치지 않는다 |
| PROCESSING | PAID | `PayoutProvider.transfer()` 성공. `paidAt`, `providerReference`, `SETTLEMENT_PAID` 알림 |
| PROCESSING | FAILED | transfer 실패. `failureReason` 기록. `payoutAttempts < 3`이면 `scheduledPayoutAt = now + 24h`로 갱신하고 payout 작업을 다시 enqueue |
| FAILED | PROCESSING | 재시도 작업 실행 |
| FAILED (3회) | (최종) | `SETTLEMENT_FAILED` 알림(이메일 필수). 이후는 운영자가 수동 처리하므로 범위 밖 |

`PayoutProvider`는 인터페이스이고 기본 구현 `LogPayoutProvider`는 로그만 남기고 성공한다(`src/lib/payout/`). 실제 송금은 범위 밖이다. 테스트는 provider를 mock해서 실패 경로를 검증한다.

**Job** (§2.0.2 참조): PENDING → RUNNING → SUCCEEDED | PENDING(재시도) | FAILED.

#### 2.1.3 업무 규칙 (BEHAVIOR.md "Money and milestone rules" 절로 명세)

| 규칙 | 값 | 근거 |
|---|---|---|
| 플랫폼 수수료 | 마일스톤 금액의 **10%**, 프리랜서 부담 | Upwork 10%, 국내 외주 중개 10% 안팎. 기존 계약 화면도 10%로 보여준다 |
| 수수료 부가세 | 수수료의 **10%**, 프리랜서 부담 | 국내 플랫폼의 "수수료 VAT 별도" 관행 |
| 계산과 반올림 | `fee = floor(gross × 1000 / 10000)`, `vat = floor(fee × 1000 / 10000)`, `net = gross − fee − vat`. 원 미만은 버린다. 정수 연산이라 부동소수 오차가 없다. 예: 1,234,567 → 123,456 / 12,345 / 1,098,766 | 기존 화면의 `Math.floor`와 맞춘다. 절사는 사용자에게 불리하지 않은 쪽 오차다 |
| 수수료율 스냅샷 | `SettlementItem.feeRateBps`에 승인 시점 요율을 저장 | 요율이 바뀌어도 과거 내역은 그대로다 |
| 정산 합계 | `Settlement`의 각 금액은 항목 값의 합. 합계에서 다시 계산하지 않는다 | 항목별 절사와 합계 절사가 어긋나지 않게 한다 |
| 금액 입력 | 신규 API의 금액은 정수(원)만 받는다. 아니면 400 | Float 부채가 신규 도메인으로 번지지 않게 한다 |
| 마일스톤 최소 금액 | 10,000원(`PUT` 계획에만 적용. 기본 마일스톤은 최소 금액 검사를 받지 않는다) | 소액 분할 남용 방지 |
| 마일스톤 개수 | 계약당 1~10개 | 일반적인 단계 분할(착수/중도/잔금 ~ 기능별) 범위 |
| 계획 합계 | Σ amount = `Math.round(contract.amount)`. 틀리면 400 `Milestone amounts must add up to the contract amount (N)` | 계약 금액은 지원서 `expectedRate`가 정본이다 |
| 기한 | `dueDate`는 `YYYY-MM-DD`. **오늘(KST)도 허용**하고 어제 이전은 400. sequence 순으로 감소하지 않음(같은 날 허용). 저장값은 해당일 23:59:59.999 KST | 날짜 단위 기한은 업계 표준이다. 당일 마감 마일스톤도 흔하다 |
| 계획 수정 시점 | 계약 `PENDING`일 때만. ACTIVE 이후 409 `Milestone plan is locked once the contract is active` | 서명한 조건이 바뀌지 않게 한다 |
| 계획 수정의 부수효과 | 서명이 하나라도 있으면 양측 서명을 모두 초기화, `contract.endDate` = 마지막 dueDate, 프리랜서에게 `MILESTONE_PLAN_UPDATED` | 조건이 바뀌면 다시 서명해야 한다는 전자계약 관행 |
| 기본 마일스톤 | 수락 시 1개 생성: `'전체 작업'`, **`amount = Math.round(contract.amount)`**, `dueDate` = 수락일 + 30일(KST 날짜). 마이그레이션 백필(`ROUND`)과 같은 규칙이다 | 계약 `endDate`(= 모집 마감일)는 이미 지났을 수 있어 기한으로 쓸 수 없다. `apply`가 `parseFloat`로 소수 `expectedRate`를 받으므로, 반올림하지 않으면 결제 페이지의 `parseInt(amount)`와 confirm의 `!==` 비교 때문에 영원히 결제할 수 없다 |
| 결제 순서 | 마일스톤은 sequence 순서대로만 결제할 수 있다. 앞선 마일스톤이 하나라도 PENDING이면 400 `Earlier milestones must be funded first` | 단계별 예치(Upwork의 "fund next milestone") |
| 제출 가능 상태 | FUNDED, REVISION_REQUESTED. 계약 ACTIVE | 결제 전 작업 제출은 의미가 없다 |
| 제출 내용 | `message` 1~5,000자 필수, `links` 0~5개(http/https), 파일 0~5개(§2.0.6 첨부 규칙) | |
| 반려 사유 | 10~2,000자 필수 | 사유 없는 반려를 막는다 |
| 반려 횟수 | 제한 없음(`revisionCount`만 기록) | 분쟁 처리가 범위 밖이라 상한을 두면 영구 교착이 된다 |
| 자동 승인 | 제출 후 `MILESTONE_AUTO_APPROVE_DAYS`(기본 **7**)일 = 168시간. 반려하면 타이머가 사라지고 재제출하면 새로 시작 | BRIEF 기본값. 크몽 "자동 구매확정"과 같은 개념 |
| 자동 승인 리마인더 | `autoApproveAt − 48시간`에 클라이언트에게 알림(인앱과 이메일 모두 끌 수 없음) | 돈이 자동으로 풀리기 전 고지 |
| 기한 알림 | FUNDED/REVISION_REQUESTED 상태에서 `dueDate − 24시간`에 프리랜서에게 `MILESTONE_DUE_SOON`, `dueDate`에 양측에게 `MILESTONE_OVERDUE`. 지연 페널티는 없음 | |
| 정산 주기 | 주 1회. 기간 = 월 00:00 ~ 다음 월 00:00 KST(`periodEnd`). 배치는 `periodEnd + 3h`(월 03:00 KST), 지급일 `scheduledPayoutAt = periodEnd + 2일 10시간`(그 주 **수 10:00 KST**) | 주간 지급(Upwork weekly)에 검토 기간 이틀 |
| 정산 대상 | `settlementId IS NULL`이고 `approvedAt < periodEnd`인 모든 항목. 배치가 밀려도 다음 배치에서 따라잡는다 | |
| 배치 재실행 | 같은 기간의 Settlement가 있으면, 그 Settlement가 SCHEDULED일 때만 새 항목을 붙이고 아니면 다음 주기로 넘긴다 | 멱등 |
| 배치 트랜잭션 단위 | 배치 전체를 한 interactive transaction에 넣지 않는다(Prisma 기본 timeout 5초). 대상 프리랜서 id 목록을 먼저 읽고 **프리랜서 1명당 트랜잭션 1개**로 Settlement upsert, 항목 연결(`updateMany where settlementId IS NULL`), 알림, payout enqueue를 묶는다. 한 명이 실패하면 그 사람만 롤백되고 핸들러는 끝에 오류를 던져 작업 재시도에 맡긴다(이미 처리된 사람은 멱등 규칙으로 건너뛴다) | 시간 초과와 부분 실패 격리 |
| 소프트 삭제와 정산 | 정산과 지급 계좌는 규칙 5의 "삭제된 프로젝트의 계약 리소스는 404"에서 **제외**한다. 한 Settlement는 여러 계약의 항목을 묶고, 완료 계약의 프로젝트는 클라이언트가 지울 수 있기 때문이다. 정산 항목 응답은 프로젝트 제목과 `projectDeleted: true` 플래그를 그대로 준다. 정산 항목 생성, 배치, 지급은 프로젝트 삭제 여부를 보지 않는다. **프리랜서 본인이 소프트 삭제**되면 배치는 그 사람의 Settlement를 만들되 payout 핸들러가 ON_HOLD로 두고 알림은 만들지 않는다(삭제된 사용자에게 알리지 않는다) | 이미 승인된 돈은 프로젝트가 지워져도 지급되어야 한다 |
| 소프트 삭제와 자동 처리 | `milestone.autoApprove`, `…Reminder`, `dueSoon`, `overdue` 핸들러는 계약의 프로젝트가 소프트 삭제됐으면 no-op 성공으로 끝난다(삭제된 프로젝트를 COMPLETED로 쓰지 않는다. D21의 신규 경로 판). 계약 당사자가 소프트 삭제된 경우 자동 승인은 그대로 진행하고(돈이 묶이지 않게), 삭제된 사용자에게 갈 알림만 건너뛴다 | |
| 최소 지급액 | 없음 | 최소 마일스톤 금액이 이미 하한 역할을 한다 |
| 지급 계좌 | 은행 코드는 고정 목록, 계좌번호는 하이픈 제거 후 숫자 10~14자리, **예금주 = 회원 이름**(공백 무시 비교) 아니면 400. 응답은 `accountNumberMasked`(끝 4자리만 노출)만 준다 | 본인 명의 계좌만 허용하는 실명 정산 관행 |
| 계좌 변경/삭제 | PROCESSING 정산이 있으면 409. SCHEDULED 정산은 지급 시점의 계좌를 쓴다 | |
| 지급 실패 재시도 | 24시간 간격 최대 3회 | |

`src/lib/banks.ts`: `004 KB국민`, `088 신한`, `020 우리`, `081 하나`, `011 NH농협`, `003 IBK기업`, `090 카카오뱅크`, `092 토스뱅크`, `089 케이뱅크`, `023 SC제일`, `031 대구`, `032 부산`. 클라이언트 `constants/banks.js`에 같은 목록을 둔다(중복은 의도된 것).

#### 2.1.4 엔드포인트

| Method | Path | 역할 | 동작 | 파일 |
|---|---|---|---|---|
| GET | `/api/contracts` | 인증(양측) | 내가 당사자인 계약 목록. `status` 필터, `page/limit`(기본 20, 최대 50). 프로젝트 제목, 상대방, `milestoneSummary`를 포함하고 프로젝트가 삭제된 계약은 제외 | 기존 `contracts.routes.ts`(`'/'`를 `'/:id'` 앞에), 컨트롤러는 신규 `contractList.controller.ts` → `services/contracts.service.ts` |
| GET | `/api/contracts/:id` | 당사자 | **[C4]** `payment` 대신 `milestones[]`(각각 `payment`, `latestSubmission`)와 `milestoneSummary {count, fundedAmount, approvedAmount, approvedCount}` | 기존 `contracts.controller.ts`(`contractInclude` 수정) |
| POST | `/api/contracts/:id/sign` | 당사자 | **[C5]** 서명 전에 계획 유효성(1개 이상, 합계 = `Math.round(contract.amount)`, 전부 PENDING)을 검사한다. 무효면 **서명 자체를 기록하지 않고** 400 `Cannot sign a contract without a valid milestone plan`(정상 API로는 도달 불가, DB를 직접 고친 경우의 방어선). 활성화 트랜잭션에서 양측에 `CONTRACT_ACTIVATED` | 기존 |
| PATCH | `/api/contracts/:id` | 인증 | **[C3]** 항상 **410** `Contracts are completed automatically when every milestone is approved`. 라우트는 남겨 envelope을 지킨다(지우면 Q10의 HTML 404가 된다) | 기존 |
| GET | `/api/contracts/:id/milestones` | 당사자 | 마일스톤 목록(sequence 순) | `contracts.routes.ts` → 신규 `milestones.controller.ts` |
| PUT | `/api/contracts/:id/milestones` | CLIENT(계약의 의뢰인) | 계획 전체 교체(§2.1.3). 트랜잭션 **첫 문장**은 `contract.updateMany({ where: { id, status: 'PENDING' }, data: { clientSigned: false, freelancerSigned: false, endDate: <마지막 dueDate> } })`이고 `count === 0`이면 409다. 이 UPDATE가 계약 row 잠금을 잡으므로 동시에 들어온 서명(같은 row를 UPDATE)과 직렬화된다. 서명이 먼저 커밋되어 ACTIVE가 됐으면 계획 교체가 409, 계획 교체가 먼저면 서명이 초기화된 계약 위에 서명이 기록된다. 이어서 기존 PENDING 마일스톤 삭제 → 생성 → (이전에 서명이 하나라도 있었으면) 알림 | 같은 곳 |
| GET | `/api/milestones/:id` | 당사자 | 상세: 제출 이력(round 내림차순, 첨부 포함), 결제, `payoutPreview {gross, fee, vat, net}`, `contract` 요약 | 신규 `milestones.routes.ts` |
| POST | `/api/milestones/:id/submissions` | FREELANCER(계약의 프리랜서) | multipart `message`, `links[]`, `files[]`(`attachmentUpload`). 파일 키는 `milestones/<milestoneId>/<uuid>.<ext>`, `fileName`은 latin1→utf8 복원값(§0). 업로드를 먼저 한 뒤 트랜잭션: 제출 생성, SUBMITTED, `autoApproveAt`, 작업 2개 enqueue, `MILESTONE_SUBMITTED` 알림 → 201 | 같은 곳 |
| POST | `/api/milestones/:id/approve` | CLIENT(계약의 의뢰인) | `approveMilestone(milestoneId, { kind: 'MANUAL', actorId: req.user.id, now })`. 트랜잭션: 조건부 APPROVED(MANUAL), 제출 결정 기록, `SettlementItem` 생성, 마지막이면 계약/프로젝트 COMPLETED와 `CONTRACT_COMPLETED`, `MILESTONE_APPROVED` 알림 | 같은 곳 |
| POST | `/api/milestones/:id/reject` | CLIENT | body `{ reason }`. 트랜잭션: 조건부 REVISION_REQUESTED, `revisionCount += 1`, `autoApproveAt = null`, 제출 결정 REJECTED, `MILESTONE_REVISION_REQUESTED` 알림 | 같은 곳 |
| POST | `/api/payments` | 인증(결제 주체 클라이언트) | **[C1]** body `{ milestoneId }`(contractId는 무시). 검사 순서와 메시지: `milestoneId` 없음 400 `Milestone ID is required` → 마일스톤 없음(또는 프로젝트 삭제) 404 `Milestone not found` → 의뢰인 아님 403 `Not authorized` → 계약 ACTIVE 아님 400 `Contract must be active to proceed with payment` → 앞선 마일스톤 중 PENDING 있음 400 `Earlier milestones must be funded first` → 마일스톤이 PENDING 아님 **409 `Milestone is already funded`**(기존 "COMPLETED 결제" 행의 `Payment already completed for this contract`를 대신한다. COMPLETED 결제가 있으면 마일스톤은 항상 FUNDED 이후이기 때문) → 그다음 기존 상태표: 결제 없음 201, PENDING 재개 200, FAILED 재시도 200, REFUNDED 409, COMPLETED 409 `Payment already completed for this milestone`(마일스톤이 PENDING인데 결제가 COMPLETED인 불일치 상태에서만 도달). amount = `milestone.amount` | 기존 `payments.controller.ts` |
| POST | `/api/payments/confirm` | 인증 | **[C1]** 성공 시 한 트랜잭션에서 payment COMPLETED와 `markFunded`(조건부 PENDING→FUNDED, `fundedAt`, `MILESTONE_FUNDED` 알림, `milestone.dueSoon`/`milestone.overdue` enqueue). `markFunded`는 0행이면 **던지지 않고** 부수효과 없이 끝난다(§2.1.2 예외). 캡처 후 DB 실패는 기존 catch-all대로 FAILED + 400이고 명세에 그렇게 적는다. D8/D18은 그대로 남긴다 | 기존 |
| POST | `/api/payments/dev-complete` | 인증 | **[C1]** body `{ milestoneId }`. confirm과 같은 부수효과(마일스톤 FUNDED, 알림, 작업) | 기존 |
| GET | `/api/payments` | 인증 | 각 결제에 `milestone {id, sequence, title}` 포함 | 기존 |
| GET | `/api/settlements` | FREELANCER | 내 정산 목록, `status` 필터, `page/limit` | 신규 `settlements.routes.ts` / `settlements.controller.ts` / `services/settlements.service.ts` |
| GET | `/api/settlements/summary` | FREELANCER | `{ unsettled: {count, gross, fee, vat, net}, scheduled: {count, net}, paidTotal, nextBatchAt, nextPayoutAt, hasPayoutAccount }` | 같은 곳(`/summary`를 `/:id` 앞에) |
| GET | `/api/settlements/:id` | FREELANCER(소유자) | 항목(마일스톤 제목, 계약 id, 프로젝트 제목, `projectDeleted`) 포함. 남의 것 403. 프로젝트 삭제 여부와 무관하게 200 | 같은 곳 |
| GET | `/api/users/me/payout-account` | FREELANCER | 마스킹된 계좌 또는 `null` | 기존 `users.routes.ts`(`/:id`보다 앞에) → 신규 `payoutAccount.controller.ts` |
| PUT | `/api/users/me/payout-account` | FREELANCER | upsert. ON_HOLD 정산을 SCHEDULED로 되돌리고 payout을 enqueue | 같은 곳 |
| DELETE | `/api/users/me/payout-account` | FREELANCER | PROCESSING 정산이 있으면 409 | 같은 곳 |

모든 신규 라우트는 `authenticate → requireActiveUser → [requireRole] → validate → controller` 순서다. 프로젝트가 소프트 삭제된 계약의 **마일스톤, 계약 목록 항목, 대화방**은 **404**(목록에서는 제외)다(규칙 5. 신규 코드는 D21을 갖지 않는다). **정산과 지급 계좌는 예외**로 프로젝트 삭제와 무관하게 보인다(§2.1.3 "소프트 삭제와 정산").

#### 2.1.5 작업 타입

| type | enqueue 시점 | runAt | dedupeKey | 핸들러 |
|---|---|---|---|---|
| `milestone.autoApprove` | 제출 | `autoApproveAt` | `milestone.autoApprove:<id>:<round>` | 프로젝트가 삭제되지 않았고 SUBMITTED이며 최신 round가 같으면 `approveMilestone(id, { kind: 'AUTO', actorId: null, now: ctx.now })`. 아니면 no-op 성공 |
| `milestone.autoApproveReminder` | 제출 | `autoApproveAt − 48h`(과거면 생략) | `milestone.autoApproveReminder:<id>:<round>` | 같은 조건에서 `MILESTONE_AUTO_APPROVE_REMINDER` |
| `milestone.dueSoon` | FUNDED 진입 | `dueDate − 24h`(과거면 생략) | `milestone.dueSoon:<id>` | FUNDED/REVISION_REQUESTED면 알림 |
| `milestone.overdue` | FUNDED 진입 | `dueDate` | `milestone.overdue:<id>` | 같은 조건이면 양측 알림 |
| `settlement.weeklyBatch` | 반복 | 월 03:00 KST | `settlement.weeklyBatch:<periodStartISO>` | 프리랜서별 Settlement 생성, 항목 연결, `SETTLEMENT_SCHEDULED`, payout enqueue |
| `settlement.payout` | 배치, 계좌 등록, 재시도 | `scheduledPayoutAt` | `settlement.payout:<settlementId>:<scheduledPayoutAt ISO>` | §2.1.2. 실행 시 `settlement.scheduledPayoutAt`이 payload의 값과 다르면(다시 잡힌 작업이 있으면) no-op |

승인 로직은 `services/milestones.service.ts`의 단일 시그니처 `approveMilestone(milestoneId: string, opts: { kind: ApprovalType; actorId: string | null; now: Date })` 한 곳에 둔다. `kind: 'MANUAL'`이면 `actorId`가 필수이고 함수 안에서 계약의 `clientId === actorId`인지(아니면 403) 검사한다. `kind: 'AUTO'`면 `actorId`는 null이고 소유권 검사를 건너뛴다. 컨트롤러와 작업 핸들러가 같은 함수를 부른다. 반려는 `rejectMilestone(milestoneId, { actorId, reason, now })`, 결제 반영은 `markFunded(tx, milestoneId, now)`로 같은 파일에 둔다.

#### 2.1.6 알림 생성 지점과 신규 타입

| type | 수신자 | 생성 위치 |
|---|---|---|
| `CONTRACT_ACTIVATED` | 양측 | `contracts.controller.ts` signContract 트랜잭션(기존 컨트롤러이지만 `notify()` 사용) |
| `MILESTONE_PLAN_UPDATED` | 프리랜서 | milestones.service `replacePlan` |
| `MILESTONE_FUNDED` | 프리랜서 | payments.controller confirm / dev-complete → `milestones.service.markFunded(tx, …)` |
| `MILESTONE_SUBMITTED` | 클라이언트 | `submitMilestone` |
| `MILESTONE_REVISION_REQUESTED` | 프리랜서 | `rejectMilestone` |
| `MILESTONE_APPROVED` | 프리랜서 | `approveMilestone`(MANUAL) |
| `MILESTONE_AUTO_APPROVED` | 양측 | `approveMilestone`(AUTO) |
| `MILESTONE_AUTO_APPROVE_REMINDER` | 클라이언트 | 작업 핸들러 |
| `MILESTONE_DUE_SOON` | 프리랜서 | 작업 핸들러 |
| `MILESTONE_OVERDUE` | 양측 | 작업 핸들러 |
| `CONTRACT_COMPLETED` | 양측(href: 계약 페이지 리뷰 영역) | `approveMilestone` 마지막 승인 |
| `SETTLEMENT_SCHEDULED` | 프리랜서 | 배치 |
| `SETTLEMENT_PAID` / `SETTLEMENT_ON_HOLD` / `SETTLEMENT_FAILED` | 프리랜서 | payout 핸들러 |

신규 타입의 제목/본문 템플릿은 `src/lib/notifications/templates.ts`에 둔다(`renderTemplate(type, vars) → {title, message, href}`). 기존 4종의 문자열은 기존 컨트롤러에 인라인으로 남긴다(BRIEF의 의도된 부채).

#### 2.1.7 클라이언트

| 경로 | 변경 |
|---|---|
| `/contracts/[id]` | 다시 쓴다. 계약 정보, 서명 현황, **마일스톤 섹션**(`MilestonePlanEditor`: PENDING + 의뢰인일 때 행 추가/삭제, 합계 일치 표시, 저장 시 서명 초기화 경고 / `MilestoneList`: 그 외), 각 마일스톤 카드의 행동 버튼(결제/제출/승인/반려), 수수료·VAT·실지급 미리보기(서버 `payoutPreview` 사용), "프로젝트 완료 처리" 버튼 삭제, 리뷰 영역 유지 |
| `/contracts/[id]/milestones/[milestoneId]` (신규) | 상세: 상태 배지, 자동 승인까지 남은 시간, 제출 이력 타임라인(첨부 링크, 반려 사유), 프리랜서 `SubmissionForm`(파일과 링크), 의뢰인 승인 / `RejectModal`(사유 10자 이상) |
| `/payments/[id]` | **id 의미가 milestoneId로 바뀐다.** `GET /api/milestones/:id`로 금액과 제목을 읽고 `POST /api/payments {milestoneId}`를 보낸다. Toss `orderName` = `${project} - ${milestone}` |
| `/payments/result` | 쿼리 `milestoneId`, `contractId`. 성공하면 계약 페이지로 돌아가는 링크 |
| `/my/payments` | 마일스톤 제목과 회차 표시 |
| `/my/contracts` (신규) | `GET /api/contracts` 목록, 상태 탭, 진행률 바(approvedAmount / 계약 금액) |
| `/settlements` (신규, FREELANCER) | `SettlementSummaryCard`(미정산/지급 예정/누적 지급, 다음 지급일), 계좌 미등록 경고 배너, 정산 목록 |
| `/settlements/[id]` (신규) | 항목 표(마일스톤, 총액, 수수료, VAT, 실지급) |
| `/settlements/account` (신규) | 지급 계좌 등록/변경/삭제 폼(은행 select, 예금주는 회원 이름 안내) |
| `components/milestones/*` | `MilestoneStatusBadge`(기존 `Badge`의 PENDING 라벨 '검토중'과 충돌하므로 따로 만든다), `MilestonePlanEditor`, `MilestoneCard`, `SubmissionForm`, `SubmissionHistory`, `RejectModal`, `PayoutPreview` |
| `components/settlements/*` | `SettlementStatusBadge`, `SettlementSummaryCard`, `SettlementTable` |
| `lib/format.js` (신규) | `formatKRW`, `formatDate`, `formatDateTime`, `formatRemaining` |
| `Header.jsx` | 드롭다운에 "내 계약", 프리랜서용 "정산" 추가 |
| `middleware.js` | `protectedRoutes`에 `/settlements` 추가(`/my`와 `/contracts`는 이미 있음) |

#### 2.1.8 건드리는 기존 코드

`schema.prisma`, `applications.controller.ts`(수락 트랜잭션에 `createDefaultMilestone(tx, contract)`), `contracts.controller.ts`(include, sign, complete → 410), `payments.controller.ts`(전면), `routes/contracts.routes.ts`, `routes/users.routes.ts`, `index.ts`(라우터 2개), `types/index.ts`, `env.ts`, `prisma/seed.js`(**이번 Phase에서 반드시** 마일스톤 기반으로 고친다. 고치지 않으면 `payment.create`가 `milestoneId` 누락으로 실패한다).
테스트: §1.6 표의 P1 행 전부. 신규 테스트 파일은 `milestones.test.ts`, `milestone-plan.test.ts`(계획 교체와 동시 서명의 직렬화 포함), `auto-approval.test.ts`, `settlements.test.ts`(ON_HOLD → 계좌 등록 → 재예약 → PAID 경로, 프로젝트 삭제 후에도 200), `payout-account.test.ts`, `money.test.ts`(순수 함수). `payments.test.ts`에는 **통과해야 하는** 회귀 테스트를 하나 넣는다: 같은 결제에 confirm 두 개를 동시에 보내도(D18은 그대로) 결제는 COMPLETED로 남고 마일스톤은 FUNDED, `MILESTONE_FUNDED` 알림은 정확히 1개다. `markFunded`가 0행에서 던지면 이 테스트가 깨진다.

#### 2.1.9 결정

- 결제는 마일스톤마다 하고 순서대로만 할 수 있다.
- 계약은 마지막 마일스톤 승인 트랜잭션에서 자동 완료되고, `PATCH /api/contracts/:id`는 410을 낸다.
- 계획은 계약 PENDING 동안 의뢰인만 바꾸고, 바꾸면 서명을 초기화한다.
- 수수료 10%와 수수료 VAT 10%는 프리랜서 부담이고 원 미만은 절사한다(오케스트레이터 확정, §6.1-4).
- 지급 계좌번호는 평문으로 저장하고 응답에서 마스킹한다. BEHAVIOR.md 열린 질문 **Q22**(D 아님, §6.1-3).
- `markFunded`는 0행이어도 던지지 않는다(기존 confirm catch-all이 409를 FAILED로 바꾸는 것을 막는다).
- 정산과 지급 계좌는 프로젝트 소프트 삭제의 404 규칙에서 제외한다. 배치는 프리랜서별 트랜잭션이다.
- payout 작업의 dedupeKey는 `scheduledPayoutAt`을 포함한다(ON_HOLD 후 재예약이 묻히지 않게).
- 정산은 주간(월 집계, 수 지급)이고, 지급은 `LogPayoutProvider`로 시뮬레이션한다.
- 지급 계좌 예금주는 회원 이름과 같아야 한다.
- 자동 승인 7일은 env로 바꿀 수 있고, 48시간 전에 리마인더를 보낸다.
- Q5(`IN_PROGRESS`)는 건드리지 않는다. 프로젝트는 지금처럼 CLOSED에서 COMPLETED로 간다.
- 환불/분쟁/계약 해지는 범위 밖이다. `REFUNDED`는 계속 쓰이지 않는다.
- 과거 완료 계약은 정산 원장에 백필하지 않는다.

#### 2.1.10 규모 추정

서버 약 2,850줄(서비스 1,350, 컨트롤러/라우트 650, 작업 핸들러 300, lib(money/time/banks/payout) 250, 기존 컨트롤러 수정 300). 클라이언트 약 2,700줄. 테스트는 신규 약 2,600줄에 기존 수정 약 900줄.

---

### 2.2 메시지 (Phase 2A)

#### 2.2.1 Prisma 모델

```prisma
enum MessageKind {
  TEXT
  SYSTEM
}

model Conversation {
  id            String    @id @default(uuid())
  contractId    String    @unique
  contract      Contract  @relation(fields: [contractId], references: [id])
  lastMessageAt DateTime?
  createdAt     DateTime  @default(now())

  participants ConversationParticipant[]
  messages     Message[]
}

model ConversationParticipant {
  id             String       @id @default(uuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  userId         String
  user           User         @relation(fields: [userId], references: [id])
  lastReadAt     DateTime?                       // 읽음 워터마크
  createdAt      DateTime     @default(now())

  @@unique([conversationId, userId])
  @@index([userId])
}

model Message {
  id             String       @id @default(uuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  senderId       String?                          // SYSTEM이면 null
  sender         User?        @relation("SentMessages", fields: [senderId], references: [id])
  kind           MessageKind  @default(TEXT)
  body           String                           // 파일만 보낼 때는 ''
  deletedAt      DateTime?
  createdAt      DateTime     @default(now())

  attachments MessageAttachment[]

  @@index([conversationId, createdAt])
}

model MessageAttachment {
  id        String   @id @default(uuid())
  messageId String
  message   Message  @relation(fields: [messageId], references: [id])
  url       String
  fileName  String
  mimeType  String
  size      Int
  createdAt DateTime @default(now())

  @@index([messageId])
}
```

마이그레이션 `expansion_messaging`: `--create-only`로 만든 뒤 기존 계약마다 Conversation 1개와 참여자 2명을 INSERT로 백필한다. 모든 INSERT에 `id = gen_random_uuid()::text`, `"createdAt" = now()`를 직접 넣는다(§0). 시스템 메시지는 백필하지 않는다. 같은 커밋에서 `seed.js`의 `deleteMany`에 `messageAttachment`, `message`, `conversationParticipant`, `conversation`을 `contract`보다 앞에 넣는다. 빠뜨리면 백필된 row 때문에 다음 시드가 P2003으로 실패한다.

#### 2.2.2 규칙

| 규칙 | 값 | 근거 |
|---|---|---|
| 대화방 생성 | 지원 수락 트랜잭션에서 계약과 함께 만든다(**[C2]** 7단계째). 시스템 메시지 "계약이 생성되었습니다. 마일스톤 계획을 확인해주세요." | 계약이 생기는 순간부터 소통 채널이 필요하다 |
| 참여자 | 계약의 client, freelancer 둘만. 그 외 403. 프로젝트가 소프트 삭제되면 404 | 규칙 3, 5 |
| 발송 가능 기간 | 계약 PENDING/ACTIVE, 그리고 COMPLETED 후 **30일**까지. 이후 409 `This conversation is closed`(읽기는 계속 가능) | 완료 후 사후 문의 기간을 남기면서 무기한 채널은 막는다 |
| 본문 | trim 후 0~5,000자. 첨부가 없으면 1자 이상 | |
| 첨부 | 메시지당 0~5개, 파일당 10MB, §2.0.6 허용 목록(`attachmentUpload`). 저장 키 `messages/<conversationId>/<uuid>.<ext>`(원본명은 키에 넣지 않는다), `MessageAttachment.fileName`에는 latin1→utf8로 복원한 원본명(§0) | 기존 Supabase 업로드 경로 재사용(BRIEF). 한글 파일명 깨짐과 비ASCII 키 거부를 피한다 |
| 읽음 | 참여자별 `lastReadAt` 워터마크. `POST /read`는 `lastReadAt = max(기존, 대화방 마지막 메시지 createdAt)`로 뒤로 가지 않는다. 상대 `lastReadAt >= message.createdAt`이면 `readByCounterpart: true` | 메신저의 "1 사라짐" |
| 안 읽은 수 | 상대가 보낸 TEXT 메시지 중 `createdAt > lastReadAt`이고 `deletedAt IS NULL`인 것. **SYSTEM 메시지는 세지 않는다** | 시스템 이벤트로 배지가 생기면 소음이 된다 |
| 삭제 | 보낸 사람만, 보낸 지 **5분 이내**. 소프트 삭제하고 응답에서는 `body: ''`, `attachments: []`, `deleted: true`. 5분이 지나면 409 | 메신저의 "모두에게서 삭제" 제한 시간 |
| 수정 | 지원하지 않음 | |
| 폴링 | 열린 대화방은 5초(탭이 보일 때만), 헤더 안 읽은 수는 30초 + `messages:changed` 이벤트 | BRIEF: WebSocket 대신 폴링 |
| 페이지네이션 | 커서 방식: `before=<messageId>`(과거), `after=<messageId>`(새 메시지), `limit` 기본 30, 최대 100. 정렬 `(createdAt, id)` | 폴링 증분 조회 |
| 알림 | 메시지는 인앱 `Notification`을 만들지 않는다. 미확인 메시지 이메일 다이제스트는 P3에서 붙인다 | 알림함이 채팅으로 넘치지 않게 한다 |
| 시스템 메시지 | 계약 생성, 계약 활성화, 마일스톤 결제/제출/반려/승인(자동 포함), 계약 완료 시 `postSystemMessage(tx, contractId, text)` | 계약 이벤트를 대화 맥락 안에서 보여준다 |

#### 2.2.3 엔드포인트

| Method | Path | 역할 | 동작 | 파일 |
|---|---|---|---|---|
| GET | `/api/conversations` | 인증 | 내 대화방 목록: 상대방, 프로젝트 제목, 계약 상태, 마지막 메시지 미리보기, `unreadCount`. `lastMessageAt desc`, `page/limit` | 신규 `conversations.routes.ts` / `conversations.controller.ts` / `services/messaging.service.ts` |
| GET | `/api/conversations/unread-count` | 인증 | `{ unreadCount }`(모든 대화방 합) | 같은 곳(`/:id`보다 앞) |
| GET | `/api/conversations/:id` | 참여자 | 대화방 상세 + `canSend`, `closesAt` | 같은 곳 |
| GET | `/api/conversations/:id/messages` | 참여자 | 커서 조회. 응답 `{ messages, hasMore }` | 같은 곳 |
| POST | `/api/conversations/:id/messages` | 참여자 | multipart `body`, `files[]` → 201. `lastMessageAt` 갱신 | 같은 곳 |
| POST | `/api/conversations/:id/read` | 참여자 | 워터마크 갱신 → `{ lastReadAt, unreadCount: 0 }` | 같은 곳 |
| DELETE | `/api/conversations/:id/messages/:messageId` | 보낸 사람 | 5분 이내 소프트 삭제 | 같은 곳 |
| GET | `/api/contracts/:id/conversation` | 당사자 | 계약의 대화방 `{ id, unreadCount }` | 기존 `contracts.routes.ts` → `conversations.controller.ts` |

`GET /api/contracts`(P1)의 각 항목에 `unreadMessageCount`를 추가한다.

#### 2.2.4 클라이언트

| 경로 | 변경 |
|---|---|
| `/messages` (신규) | 좌측 `ConversationList`, 우측 빈 상태. 모바일에서는 목록만 |
| `/messages/[id]` (신규) | `MessageThread`(무한 스크롤 위로 `before`, 5초 `after` 폴링), `MessageBubble`(읽음 표시, 삭제 메뉴, 시스템 메시지 스타일), `MessageComposer`(텍스트, 파일 선택, 업로드 진행, Enter 전송 / Shift+Enter 줄바꿈), 들어오면 `POST /read` |
| `hooks/usePolling.js` (신규) | `visibilitychange`를 반영하는 interval 훅 |
| `Header.jsx` | "메시지" 링크와 안 읽은 수 배지(알림 배지와 같은 패턴). **P2에서 `Header.jsx`를 고치는 워커는 p2a-client 하나뿐이다** |
| 공용 파일 | `lib/format.js`, `components/ui/*`는 읽기만 한다. 메시지 전용 헬퍼는 `components/messages/` 안에 둔다 |
| `/contracts/[id]` | "메시지" 버튼(안 읽은 수) |
| `/my/contracts` | 안 읽은 메시지 수 배지 |
| `middleware.js` | `/messages` 보호 |

#### 2.2.5 건드리는 기존 코드와 테스트

`applications.controller.ts`(수락 트랜잭션), `services/milestones.service.ts`와 `payments.controller.ts`, `contracts.controller.ts`(시스템 메시지 훅), `contracts.routes.ts`, `index.ts`, `test/applications.test.ts`(수락 단계), `authorization.test.ts`, `soft-delete.test.ts`. 신규 테스트는 `conversations.test.ts`, `messages.test.ts`(첨부, 삭제 5분 경계, 커서), `message-read.test.ts`.

#### 2.2.6 결정

- 대화방은 계약당 하나이고 수락 트랜잭션에서 만든다. 기존 계약은 마이그레이션으로 백필한다.
- 읽음은 워터마크 방식이고, 시스템 메시지는 안 읽은 수에서 뺀다.
- 완료 후 30일까지 발송할 수 있고, 삭제는 5분 이내만 되며, 수정은 없다.
- 메시지는 인앱 알림을 만들지 않는다.
- 첨부는 기존 public 버킷에 uuid 키로 둔다(오케스트레이터 확정, §6.1-2). BEHAVIOR.md에는 D가 아니라 열린 질문 **Q21**로 적는다.

#### 2.2.7 규모 추정

서버 약 1,000줄, 클라이언트 약 1,250줄, 테스트 약 1,100줄.

---

### 2.3 프로필 확장 (Phase 2B)

#### 2.3.1 Prisma 모델

```prisma
enum EmploymentType {
  FULL_TIME
  CONTRACT
  FREELANCE
  INTERN
}

model PortfolioItem {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  title       String
  description String?
  url         String?
  imageUrl    String?
  role        String?                       // 본인 역할(예: "프론트엔드 리드")
  skills      String[]                      // normalizeSkillList로 정규화
  startedAt   DateTime?                     // 월 단위(1일)
  endedAt     DateTime?
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([userId, sortOrder])
}

model Career {
  id             String         @id @default(uuid())
  userId         String
  user           User           @relation(fields: [userId], references: [id])
  company        String
  position       String
  employmentType EmploymentType
  startDate      DateTime                     // 월 단위(1일, KST)
  endDate        DateTime?                    // null = 재직 중
  description    String?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@index([userId, startDate])
}
```

마이그레이션 이름은 `expansion_profile_portfolio_careers`이다(P2-S에서 만든다). 같은 커밋에서 `seed.js`의 `deleteMany`에 `portfolioItem`, `career`를 `user`보다 앞에 넣는다. 기존 `User.portfolioUrl`은 "대표 포트폴리오 링크"로 남긴다(지우지 않는다).

#### 2.3.2 규칙

| 규칙 | 값 |
|---|---|
| 쓰기 권한 | FREELANCER만(`requireRole`). CLIENT 403 |
| 포트폴리오 개수 | 사용자당 최대 20개, 초과 409 |
| 포트폴리오 필드 | title 1~100, description ≤ 2,000, url은 http/https, 이미지는 P0의 `imageUpload`(이미지 전용 5MB, 413/400. 기존 `upload`는 D6 때문에 쓰지 않는다) → 키 `portfolio/<uuid>.<ext>`, skills ≤ 10개(정규화와 중복 제거), `startedAt ≤ endedAt`(YYYY-MM) |
| 정렬 | `sortOrder` 오름차순, 같으면 `createdAt desc`. 새 항목은 맨 뒤(max + 1). `PUT /order`는 내 항목 id 전부의 순열이어야 함(누락/중복/남의 id → 400) |
| 경력 개수 | 최대 30개 |
| 경력 필드 | company 1~100, position 1~100, `startDate`와 `endDate`는 `YYYY-MM`. `startDate`는 이번 달 이전이어야 하고 `endDate`(있으면)는 `startDate` 이상. `endDate` 없음 = 재직 중. 재직 중은 동시에 여러 개 가능 |
| 경력 합계 | `careerSummary.totalMonths`: 기간 겹침을 병합한 개월 수(재직 중이면 이번 달까지). 표시용이고 `experienceYears`를 덮어쓰지 않는다 |
| 공개 노출 | `GET /api/users/:id`에 `portfolioItems`(전부), `careers`(startDate desc), `careerSummary`(**[C10]**). 소프트 삭제 사용자는 404(기존과 같음) |
| 완성도 게이트 | `isProfileComplete`(지원/등록 게이트)는 **바꾸지 않는다** |
| 완성도 점수 | `getProfileCompletion(user, counts)` → `{ isComplete, percent, items[] }`. FREELANCER 가중치: skills 15, activityCategory 10, experienceYears 10, hourlyRate 10, bio 10, profileImage 10, 포트폴리오 1개 이상 15, 포트폴리오 3개 이상 5, 경력 1개 이상 10, 지급 계좌 5 = 100. CLIENT: companyName 25, businessField 25, bio 15, profileImage 15, website 20 = 100 |
| 프리랜서 추천 (프로젝트 기준) | 후보: FREELANCER, `deletedAt null`, `isProfileComplete`, 이 프로젝트에 지원하지 않은 사람, 프로젝트 `requiredSkills`가 있으면 스킬이 하나 이상 겹치는 사람(`expandSkillSearchTerms`로 `skills: { hasSome }` prefilter, **`orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]`로 정렬한 뒤 앞 200명**. 정렬 없이 자르면 어떤 200명이 들어오는지가 실행마다 달라진다). 점수(100점): 스킬 겹침 비율 × 50 + 포트폴리오 스킬 커버리지 × 10 + (activityCategory = project.category) 15 + 평점(리뷰가 있으면 avg / 5, 없으면 0.6) × 15 + min(경력연수, 10) / 10 × 10. 소수 둘째 자리 반올림. 정렬: 점수 desc → reviewCount desc → id asc. 기본 10명, 최대 20명. 응답에 `score`, `matchedSkills`, `avgRating`, `reviewCount`, 포트폴리오 미리보기 3개 |
| 프로젝트 추천 (프리랜서 기준) | 프로필 완성 필요(`requireCompleteProfile`, 403). 후보: `status OPEN`, `deadline >= now`, `deletedAt null`, 아직 지원하지 않은 프로젝트. prefilter는 내 스킬로 `requiredSkills: { hasSome }` OR 카테고리 일치, `orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]`, 앞 200개. **지연 스윕을 부르지 않는다**(신규 GET은 쓰지 않는다). 점수: 프로젝트 요구 스킬 커버리지 × 50 + 내 스킬 활용도(겹침 / 내 스킬 수) × 10 + 카테고리 일치 20 + 최신성(등록 7일 이내 10점, 30일에 걸쳐 선형으로 0점) + 마감 여유(3일 이상 10점, 그 미만 0점). 요구 스킬이 없는 프로젝트는 카테고리가 일치할 때만 후보. 기본 10개, 최대 20개 |

#### 2.3.3 엔드포인트

| Method | Path | 역할 | 동작 | 파일 |
|---|---|---|---|---|
| GET | `/api/users/:id/portfolio` | 공개 | 포트폴리오 목록 | 신규 `profile.routes.ts`(`/api/users`에 `userRoutes` **다음**으로 마운트) / `profile.controller.ts` / `services/portfolio.service.ts` |
| POST | `/api/users/me/portfolio` | FREELANCER | multipart(`image` 선택) → 201 | 같은 곳 |
| PATCH | `/api/users/me/portfolio/:itemId` | FREELANCER(소유자) | 부분 수정, `image` 교체 가능, `removeImage=true` | 같은 곳 |
| DELETE | `/api/users/me/portfolio/:itemId` | FREELANCER(소유자) | 하드 삭제 | 같은 곳 |
| PUT | `/api/users/me/portfolio/order` | FREELANCER | `{ ids: [] }` 순서 재배치 | 같은 곳(`/:itemId`보다 앞) |
| GET | `/api/users/:id/careers` | 공개 | 경력 목록 + `careerSummary` | 같은 곳, `services/careers.service.ts` |
| POST | `/api/users/me/careers` | FREELANCER | 생성 → 201 | 같은 곳 |
| PATCH | `/api/users/me/careers/:careerId` | FREELANCER(소유자) | 수정 | 같은 곳 |
| DELETE | `/api/users/me/careers/:careerId` | FREELANCER(소유자) | 하드 삭제 | 같은 곳 |
| GET | `/api/users/me/profile-completion` | 인증 | 완성도 점수 | 같은 곳 |
| GET | `/api/users/me/recommended-projects` | FREELANCER, 프로필 완성 | 프로젝트 추천 | 같은 곳 → `recommendations.controller.ts` / `lib/recommendations.ts` |
| GET | `/api/projects/:id/recommended-freelancers` | CLIENT(소유자) | 프리랜서 추천. 프로젝트 없음/삭제 404, 남의 프로젝트 403 | 기존 `projects.routes.ts` → `recommendations.controller.ts` |
| GET | `/api/users/:id` | 공개 | **[C10]** 응답 확장 | 기존 `users.controller.ts` |

라우팅 주의: `users.routes.ts`에는 `/:id`와 `/:id/reviews`가 있다. `/me/portfolio`는 두 세그먼트라서 `/:id`와 충돌하지 않지만, 마운트 순서와 각 라우터 안의 순서를 index.ts 주석에 적는다(projects/applications 이중 마운트와 같은 관례). 새 공개 라우트 2개가 생기므로 `types/index.ts`의 "9 public routes" 주석, `authorization.test.ts`의 `PUBLIC_ROUTES` 개수, CLAUDE.md의 같은 문장을 고친다.

#### 2.3.4 클라이언트

| 경로 | 변경 |
|---|---|
| `/profile` | 위쪽에 `ProfileCompletionCard`(퍼센트 바, 빠진 항목 링크), 프리랜서에게는 "포트폴리오 관리" / "경력 관리" 링크 |
| `/profile/portfolio` (신규) | `PortfolioGrid`(위/아래 버튼으로 순서 변경), `PortfolioItemModal`(이미지 미리보기, 스킬 선택은 기존 `CheckboxChips`와 `SKILL_OPTIONS` 재사용) |
| `/profile/careers` (신규) | `CareerTimeline`, `CareerFormModal`(YYYY-MM 입력, 재직 중 체크) |
| `/users/[id]` | 포트폴리오 그리드, 경력 타임라인, "총 경력 N년 M개월" |
| `/projects/[id]/applications` | 오른쪽 `RecommendedFreelancers` 패널(점수, 일치 스킬, 평점, 프로필 링크) |
| `/` 와 `/my/recommendations` (신규) | 로그인한 프리랜서에게 `RecommendedProjects` 섹션(홈에는 3개와 "더 보기" 링크, 전용 페이지에는 20개). 프로필 미완성이면 완성 유도. **`Header.jsx`는 고치지 않는다**(P2에서 헤더는 p2a-client 전용). 헤더 드롭다운의 "추천 프로젝트" 링크는 P4에서 추가한다 |
| 공용 파일 | `lib/format.js`, `components/ui/*`는 P1이 만든 것을 **읽기만** 한다. 새 헬퍼가 필요하면 `components/profile/` 안에 둔다(p2a-client와 충돌 방지) |
| `lib/profileCompletion.js` | 서버 결과를 표시하는 헬퍼로 확장(기존 게이트 함수는 유지) |
| `middleware.js` | `/profile`과 `/my`는 이미 보호됨 |

#### 2.3.5 건드리는 기존 코드와 테스트

`users.controller.ts`(getUserById), `lib/profileCompletion.ts`(함수 추가), `lib/skills.ts`(변경 없이 재사용), `projects.routes.ts`, `index.ts`, `types/index.ts`. 테스트: `users.test.ts`(공개 프로필), `lib.test.ts`(`getProfileCompletion`, 경력 병합, 점수 함수), 신규 `portfolio.test.ts`, `careers.test.ts`, `recommendations.test.ts`, `profile-completion.test.ts`, authorization/soft-delete 표.

#### 2.3.6 결정

- 완성도 게이트는 그대로 두고 점수만 추가한다(기존 지원 흐름과 시드를 깨지 않는다).
- 추천은 DB prefilter 후 메모리에서 점수를 매기고, 결정적 tie-break를 둔다.
- 신규 추천 GET은 지연 스윕을 부르지 않고 `deadline >= now`로 거른다.
- `portfolioUrl`을 유지한다. 포트폴리오와 경력은 하드 삭제한다.

#### 2.3.7 규모 추정

서버 약 1,350줄, 클라이언트 약 1,700줄, 테스트 약 1,200줄.

---

### 2.4 알림 채널 (Phase 3)

#### 2.4.1 Prisma 모델

```prisma
enum EmailDeliveryStatus {
  QUEUED
  SENT
  FAILED
  SKIPPED      // 수신자 소프트 삭제 등
}

model NotificationPreference {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  type      String
  inApp     Boolean
  email     Boolean
  updatedAt DateTime @updatedAt

  @@unique([userId, type])
}

model EmailDelivery {
  id                String              @id @default(uuid())
  userId            String
  user              User                @relation(fields: [userId], references: [id])
  notificationId    String?                           // 인앱이 꺼져 있으면 null
  type              String
  toAddress         String
  subject           String
  body              String
  status            EmailDeliveryStatus @default(QUEUED)
  contextKey        String?                           // 예: 'conversation:<id>' (다이제스트 throttle 조회용)
  provider          String                            // 'log'
  providerMessageId String?
  error             String?
  sentAt            DateTime?
  createdAt         DateTime            @default(now())

  @@index([userId, createdAt])
  @@index([userId, type, contextKey, createdAt])
  @@index([status])
}
```

마이그레이션 이름은 `expansion_notification_channels`이다. 같은 커밋에서 `seed.js`의 `deleteMany`에 `emailDelivery`, `notificationPreference`를 `user`보다 앞에 넣는다. 설정 row는 **기본값과 다를 때만** 저장한다(희소 저장). 기본값은 코드의 정책 표가 정본이다.

#### 2.4.2 정책 표 (`src/lib/notifications/policy.ts`, BEHAVIOR.md에 같은 표를 둔다)

| type | 수신 역할 | 인앱 기본 | 인앱 끄기 | 이메일 기본 | 이메일 끄기 |
|---|---|---|---|---|---|
| `APPLICATION_CREATED` | CLIENT | on | 가능 | on | 가능 |
| `APPLICATION_ACCEPTED` | FREELANCER | on | **불가** | on | 가능 |
| `APPLICATION_REJECTED` | FREELANCER | on | 가능 | off | 가능 |
| `PROJECT_STATUS_CHANGED` | FREELANCER | on | 가능 | off | 가능 |
| `CONTRACT_ACTIVATED` | 양측 | on | 불가 | on | 가능 |
| `MILESTONE_PLAN_UPDATED` | FREELANCER | on | 불가 | on | 가능 |
| `MILESTONE_FUNDED` | FREELANCER | on | 불가 | on | 가능 |
| `MILESTONE_SUBMITTED` | CLIENT | on | 불가 | on | 가능 |
| `MILESTONE_REVISION_REQUESTED` | FREELANCER | on | 불가 | on | 가능 |
| `MILESTONE_APPROVED` | FREELANCER | on | 불가 | on | 가능 |
| `MILESTONE_AUTO_APPROVE_REMINDER` | CLIENT | on | 불가 | on | **불가** |
| `MILESTONE_AUTO_APPROVED` | 양측 | on | 불가 | on | 가능 |
| `MILESTONE_DUE_SOON` | FREELANCER | on | 가능 | on | 가능 |
| `MILESTONE_OVERDUE` | 양측 | on | 가능 | on | 가능 |
| `CONTRACT_COMPLETED` | 양측 | on | 불가 | on | 가능 |
| `SETTLEMENT_SCHEDULED` | FREELANCER | on | 가능 | off | 가능 |
| `SETTLEMENT_PAID` | FREELANCER | on | 불가 | on | 가능 |
| `SETTLEMENT_ON_HOLD` | FREELANCER | on | 불가 | on | **불가** |
| `SETTLEMENT_FAILED` | FREELANCER | on | 불가 | on | **불가** |
| `MESSAGE_UNREAD_DIGEST` | 양측 | (인앱 없음) | — | on | 가능 |

근거: 거래와 돈에 관한 알림은 끌 수 없는 "필수 알림"으로 두는 것이 국내외 플랫폼의 공통 관행이다. 돈이 자동으로 움직이기 직전 알림과 지급 문제 알림은 이메일까지 강제한다.

#### 2.4.3 동작

- `notify(tx, input)`(P0 최소판을 확장, `input`에 선택 필드 `contextKey`를 추가해 `EmailDelivery.contextKey`로 저장): (1) 정책과 사용자 설정을 합쳐 `inApp`/`email`을 정한다. (2) inApp이면 `Notification` row를 만든다. (3) email이고 수신자가 소프트 삭제되지 않았으면 `EmailDelivery(QUEUED)`를 만들고 `email.send`를 enqueue한다(dedupe `email.send:<deliveryId>`). 셋 다 호출자의 트랜잭션 안에서 일어나서 상태 변경이 롤백되면 메일도 나가지 않는다. `notifyMany`는 수신자별 설정을 한 번의 `findMany`로 읽는다.
- **기존 생성 지점 연결**: `applications.controller.ts`의 `apply`(`APPLICATION_CREATED`), 수락(`ACCEPTED` + `REJECTED` 일괄), 거절, `projects.controller.ts`의 `updateProjectStatus`(`PROJECT_STATUS_CHANGED` 일괄)를 `tx.notification.create/createMany`에서 `notify/notifyMany`로 바꾼다. 제목/본문 문자열은 **그 컨트롤러에 인라인으로 남긴다**. 신규 도메인만 `templates.ts`를 쓴다. BRIEF가 말한 "일부만 옮겨진" 상태가 바로 이것이고, 동작(설정 반영, 이메일)은 모든 지점에서 같다.
- `email.send` 핸들러: delivery를 읽어 QUEUED가 아니면 no-op. 수신자가 소프트 삭제됐으면 SKIPPED. `EmailSender.send({ to, from, subject, text })`를 부르고 성공하면 SENT(`sentAt`, `providerMessageId`), 예외가 나면 작업 재시도(최대 5회)에 맡기고 마지막 실패에서 FAILED(`error`)로 둔다.
- `EmailSender` 인터페이스(`src/lib/email/`): `LogEmailSender`가 기본(`EMAIL_PROVIDER=log`)이고 `logger.info('email.sent', {to, subject, …})` 후 `log-<uuid>`를 돌려준다. 다른 값이면 부팅 시점이 아니라 첫 발송 시 `PermanentJobError`(env lazy 원칙). 외부 계정 없이 로컬에서 동작한다.
- 메일 렌더링 `render.ts`: 제목 `[WorkBridge] {title}`, 본문은 message, 빈 줄, `바로가기: ${CLIENT_URL ?? 'http://localhost:3000'}${href}`, 마지막 줄 `알림 설정: …/my/notifications/settings`.
- **미확인 메시지 다이제스트**: 시계 기반 버킷 키는 쓰지 않는다(정시 경계에서 메일이 사라지거나 1분 간격으로 두 통이 나가고, 테스트가 시각에 따라 흔들린다). 대신 다음과 같이 한다.
  - **enqueue (P2A 메시지 생성 트랜잭션에 P3가 추가)**: 수신자마다, `type='message.unreadDigest'`, `status='PENDING'`, `payload.conversationId`/`payload.recipientId`가 같은 Job이 이미 있으면(`payload: { path: [...], equals }` 필터) 아무것도 하지 않고, 없으면 `runAt = now + 10분`, **dedupeKey 없이** enqueue한다. 동시에 두 메시지가 들어와 PENDING 작업이 둘 생겨도 아래 잠금과 throttle 때문에 메일은 한 통이다.
  - **핸들러 (`ctx.now` 기준)**: 한 트랜잭션에서 (1) 수신자의 `ConversationParticipant` row를 `SELECT … FOR UPDATE`로 잠근다. (2) 그 대화방의 수신자 미확인 수가 0이면 끝(no-op). (3) 같은 수신자와 대화방의 `MESSAGE_UNREAD_DIGEST` `EmailDelivery`(`contextKey = 'conversation:<id>'`) 중 최근 것이 `ctx.now − 60분` 이후에 만들어졌으면 메일을 보내지 않고, 같은 쌍의 PENDING 작업이 없을 때만 `runAt = 그 발송 시각 + 60분`으로 다시 enqueue한다(버리지 않는다). (4) 아니면 `notify(tx, { type: 'MESSAGE_UNREAD_DIGEST', contextKey, … })`로 "새 메시지 N개" 메일을 만든다(이메일 전용).
  - 결과: 10분 안에 읽으면 메일이 가지 않고, 대화방과 수신자 쌍마다 60분에 최대 한 통이며, 그 사이에 쌓인 미확인 메시지는 60분 뒤 한 통으로 나간다. 테스트는 `runDueJobs({ now })`만으로 결정적이다.
- **설정 API 검증**: 필수 채널을 끄려 하면 400 `<type>: in-app notifications cannot be disabled`. 모르는 type이면 400. 다른 역할 전용 type도 저장은 허용한다(역할이 바뀌어도 유지되게).

#### 2.4.4 엔드포인트

| Method | Path | 역할 | 동작 | 파일 |
|---|---|---|---|---|
| GET | `/api/notifications/preferences` | 인증 | 내 역할에 해당하는 type 전부를 정책 기본값과 내 설정을 합쳐서 반환: `{ preferences: [{ type, label, category, inApp, email, inAppLocked, emailLocked }] }` | 기존 `notifications.routes.ts`(`/:id/read` 앞) → 신규 `notificationPreferences.controller.ts` / `services/notificationPreferences.service.ts` |
| PUT | `/api/notifications/preferences` | 인증 | `{ preferences: [{type, inApp?, email?}] }` 부분 갱신. 기본값과 같아지면 row 삭제 | 같은 곳 |
| GET | `/api/notifications` | 인증 | 변화 없음. type 목록만 늘어난다(**[C9]**) | 기존 |

#### 2.4.5 클라이언트

| 경로 | 변경 |
|---|---|
| `/my/notifications/settings` (신규) | 카테고리별 표(지원, 계약, 마일스톤, 정산, 메시지), 인앱/이메일 토글, 잠긴 항목은 비활성화하고 툴팁, "이메일 전체 끄기" 버튼(끌 수 있는 것만) |
| `/my/notifications` | type별 아이콘과 라벨, 설정 링크 |
| `Header.jsx` | 드롭다운에 "알림 설정" |

#### 2.4.6 건드리는 기존 코드와 테스트

`applications.controller.ts`, `projects.controller.ts`(알림 지점 4곳), `services/messaging.service.ts`(다이제스트 enqueue), `lib/notifications/notify.ts`. 테스트: `notifications.test.ts`(설정에 따른 억제), `applications.test.ts`와 `projects-write.test.ts`(기본 설정에서 알림 수 불변인지 확인), 신규 `notification-preferences.test.ts`, `email.test.ts`(enqueue, 발송, 재시도, SKIPPED, 롤백 시 미발송), `message-digest.test.ts`.

#### 2.4.7 결정

- 설정은 희소 저장이고 기본값은 코드 정책 표다.
- 거래/정산 알림은 인앱 필수, 자동승인 임박과 지급 문제는 이메일도 필수다.
- 메시지는 이메일 다이제스트만 보낸다(10분 지연, 시간당 1통).
- 모든 기존 지점이 `notify`를 거치지만 문구는 인라인으로 남는다.
- 메일은 `EmailDelivery`로 감사 추적한다.

#### 2.4.8 규모 추정

서버 약 1,300줄, 클라이언트 약 400줄, 테스트 약 1,100줄.

---

## 3. 실행 순서와 병렬화

### 3.1 스키마 순서 정책 (권장안)

**도메인별로 "명세 + 스키마 + 마이그레이션 + 팩토리/TABLES" 커밋을 통합 브랜치에서 직렬로 먼저 만들고, 그 위에서 병렬 작업을 연다.** 모든 스키마를 처음에 한꺼번에 만들지는 않는다.
- 이유 1: `schema.prisma`는 파일 하나라서 두 워커가 `User` 역관계를 동시에 추가하면 반드시 충돌한다.
- 이유 2: Phase 1 마이그레이션은 데이터 백필을 손으로 쓰는 특수 작업이라 혼자 검증해야 한다.
- 이유 3: 명세를 먼저 쓰라는 BRIEF 규칙 때문에, 스키마를 앞당기면 명세 없이 스키마를 설계하게 된다.
- Phase 2A와 2B의 스키마는 **한 워커가 한 커밋 묶음(마이그레이션 2개)으로** 만든다(Phase 2-S). 그래서 2A와 2B 워커는 둘 다 `schema.prisma`를 건드리지 않는다. 구현 중에 스키마 수정이 꼭 필요하면 오케스트레이터에게 올리고, 통합 브랜치에서 직렬로 반영한 뒤 rebase한다.
- 마이그레이션 타임스탬프는 Prisma가 생성 시각으로 붙이므로 직렬로 만들면 순서가 보장된다. 병렬 브랜치에서 마이그레이션을 만들지 않는다.

### 3.2 Phase 목록

| Phase | 내용 | 의존 | 병렬 | 서버 | 클라 | 테스트 |
|---|---|---|---|---|---|---|
| **P0 인프라** | §2.0 전부. 명세: 규칙 1, 7 수정 + 규칙 9~12 신설, login/analyze 429. 클라이언트 프록시 두 곳(PUT, 헤더 전달) | 없음 | 단독(모든 것의 기반) | ~1,650 | ~70 | ~1,150 |
| **P1 마일스톤/정산** | §2.1. 단계: 1a 명세 → 1b 스키마+백필 마이그레이션+팩토리+시드 → 1c 서버+테스트 → 1d 클라이언트 | P0 | **도메인 단위로는 단독.** 1b 이후 1c(서버)와 1d(클라이언트)는 서로 다른 worktree에서 병렬 가능(명세가 계약). 머지는 1c → 1d | ~2,850 | ~2,700 | ~3,500 |
| **P2-S 명세+스키마** | 메시지와 프로필의 BEHAVIOR.md 절, 마이그레이션 2개(`expansion_messaging`은 Conversation 백필 포함, `expansion_profile_portfolio_careers`), TABLES, 팩토리(`makeConversation`, `makeMessage`, `makePortfolioItem`, `makeCareer`), `index.ts` 라우터 마운트 자리(빈 라우터), `seed.js` `deleteMany` 목록 | P1 | 단독(짧음) | ~150 | 0 | ~150 |
| **P2A 메시지** | §2.2 서버+테스트, 클라이언트 | P2-S | **P2B와 병렬.** 내부에서도 서버/클라 병렬 가능 | ~1,000 | ~1,250 | ~1,100 |
| **P2B 프로필** | §2.3 서버+테스트, 클라이언트 | P2-S | **P2A와 병렬** | ~1,350 | ~1,700 | ~1,200 |
| **P3 알림 채널** | §2.4. 3a 명세 → 3b 스키마 → 3c 서버(notify 확장, 기존 지점 연결, 다이제스트)+테스트 → 3d 클라이언트 | P0(큐), P1/P2A의 알림·메시지 생성 지점 | 단독(모든 도메인의 생성 지점을 건드린다). 3c와 3d는 병렬 가능 | ~1,300 | ~400 | ~1,100 |
| **P4 마무리** | §5 | 전부 | 단독 | ~0 | ~50 | 0 |
| **합계(추정)** | | | | **약 8,300 추가 → 서버 ≈ 11,040** | **약 6,170 추가 → 클라 ≈ 10,900** | 약 8,200 추가 |

제품 코드 합계는 약 21,900줄로 BRIEF 목표(2만 이상)를 넘는다. 추정이 빗나가 2만에 못 미치면 P4에서 줄 수를 채우지 않는다. 규모보다 얽힘이 목적이다(BRIEF).

### 3.3 왜 이 순서인가

- **P0이 맨 앞인 이유**: 자동 승인, 정산 배치, 이메일이 전부 큐를 쓰고, 신규 도메인이 zod/`requireActiveUser`/`notify`/첨부 업로드를 처음부터 쓴다.
- **P1이 단독인 이유**: 기존 계약/결제의 동작, 테스트(payments·contracts·applications·authorization·soft-delete), 명세, 시드를 다시 쓴다. 다른 도메인이 동시에 돌면 기준선이 흔들린다.
- **P2A와 P2B가 병렬인 이유**: 둘은 서로 참조하지 않는다. P2A는 수락 트랜잭션과 마일스톤 서비스(시스템 메시지)를 건드리고, P2B는 users/projects 쪽을 건드리므로 겹치는 파일이 공통 표 파일뿐이다.
- **P3가 마지막인 이유**: 큐(P0)와 다른 모든 도메인의 알림 생성 지점(P1, P2A의 메시지 생성)에 의존하고, 기존 컨트롤러 4곳을 바꾼다.

### 3.4 병렬 워커 배치와 머지 순서

각 워커의 환경은 §0 "병렬 워커 환경"대로 만든다. 워커마다 자기 worktree, 테스트 DB `workbridge_test_<이름>`, 개발 DB `workbridge_dev_<이름>`, 서버/클라이언트 포트 쌍을 쓴다.

| 슬롯 | 워커 | worktree | 테스트 DB / 개발 DB | 포트(서버/클라) | 머지 순서 |
|---|---|---|---|---|---|
| P1 | `p1-server`(1c) | `../wb-p1-server` | `workbridge_test_p1s` / `workbridge_dev_p1s` | 4001 / 3001 | 1c 먼저 |
| P1 | `p1-client`(1d) | `../wb-p1-client` | (테스트 없음) / `workbridge_dev_p1c`(1b 마이그레이션 적용, 화면 확인용으로 p1-server 브랜치를 띄움) | 4002 / 3002 | 1c 다음 |
| P2 | `p2b-server` | `../wb-p2b-server` | `workbridge_test_p2b` / `workbridge_dev_p2b` | 4001 / 3001 | 1번째 |
| P2 | `p2a-server` | `../wb-p2a-server` | `workbridge_test_p2a` / `workbridge_dev_p2a` | 4002 / 3002 | 2번째(수락 트랜잭션과 마일스톤 서비스를 건드리므로 p2b 머지 후 rebase) |
| P2 | `p2b-client` | `../wb-p2b-client` | — / `workbridge_dev_p2bc` | 4003 / 3003 | 3번째 |
| P2 | `p2a-client` | `../wb-p2a-client` | — / `workbridge_dev_p2ac` | 4004 / 3004 | 4번째(`Header.jsx` 단독 소유) |
| P3 | `p3-server`, `p3-client` | `../wb-p3-server`, `../wb-p3-client` | `workbridge_test_p3` / `workbridge_dev_p3s`, `workbridge_dev_p3c` | 4001/3001, 4002/3002 | server → client |

클라이언트 워커는 같은 Phase의 서버 브랜치를 자기 포트로 함께 띄워 화면을 확인한다(서버 머지 전이면 서버 worktree를 읽기 전용으로 checkout). **종료 조건 3(시드 스모크)과 4(실행 확인)의 공식 판정은 머지 담당이 매 머지 직후 통합 브랜치에서 기본 `.env`(`workbridge` DB, 4000/3000)로 한다.** 병렬 워커는 자기 환경에서 미리 확인할 수는 있지만 그것으로 종료 조건을 대신하지 않는다.

**P2-S가 이미 해소한 것**: `schema.prisma`, 마이그레이션, `test/helpers/db.ts` `TABLES`, `test/helpers/factories.ts`의 신규 팩토리, `src/index.ts` 라우터 마운트, `seed.js` `deleteMany` 목록, BEHAVIOR.md 두 도메인 절.

**해소되지 않았지만 손으로 머지할 수 있는 파일 (머지 담당이 매번 확인한다)**
- `test/authorization.test.ts`: 양쪽이 `PROTECTED_ROUTES`/`PUBLIC_ROUTES` 행, `Ids` 인터페이스와 `MISSING` 필드, 개수 단언(전체, 역할 게이트, CLIENT/FREELANCER 분할), 파일 머리의 라우터별 내역 주석을 바꾼다. 해결: 행과 필드는 둘 다 살리고 개수는 표 길이로 다시 세며 주석도 다시 쓴다.
- `test/soft-delete.test.ts`: 신규 행은 `guardedMutations`(`it.each`)에만 들어간다. 둘 다 살린다. `mutations`(`it.fails.each`)에 신규 행이 들어가 있으면 머지 전에 옮긴다.
- `src/types/index.ts`: 양쪽이 타입과 "public routes" 주석을 고친다. 둘 다 살리고 공개 라우트 수를 다시 센다.
- `docs/BEHAVIOR.md`의 D번호: 워커는 임시로 `D-2A-1`, `D-2B-1`처럼 적는다. 머지 담당이 Outstanding 표의 번호를 확정하고, **같은 태그를 쓰는 `it.fails(... [D-2A-1])` 테스트 이름도 함께 바꾼다**(`grep -rn "D-2[AB]-" docs test`가 비어야 한다).
- `docs/expansion/PROGRESS.md`, `DECISIONS.md`: 추가 줄만 있으므로 둘 다 살린다.
- `workbridge-client/src/components/layout/Header.jsx`: p2a-client만 고친다. p2b-client 브랜치에 Header 변경이 있으면 머지 전에 되돌린다(추천 링크는 P4).
- `workbridge-client/src/lib/format.js`, `components/ui/*`: P2에서는 읽기 전용이다. 그래도 수정이 생겼으면 함수 단위로 둘 다 살린다.
- `prisma/seed.js`: P2 워커는 시연 데이터를 넣지 않는다(P4). 넣었으면 머지 담당이 P4로 미루거나 둘 다 살린 뒤 시드 스모크를 다시 돌린다.

### 3.5 Phase 공통 종료 절차

§0 "Phase 종료 조건"과 같다. 추가로 각 Phase는 다음 커밋 단위를 따른다(BRIEF).
1. `docs: <도메인> 명세` (BEHAVIOR.md)
2. `feat(server): <도메인> 스키마와 마이그레이션` (+ 팩토리, TABLES, 시드 최소 수정)
3. `feat(server): <도메인> 구현과 테스트`
4. `feat(client): <도메인> 화면`
5. (필요 시) `fix: 검증 지적 반영`

---

## 4. 명세(BEHAVIOR.md) 확장 방식

현재 형식은 영어이고 순서는 목적 → Cross-cutting rules(1~8) → 리소스별 절(`### METHOD /path — role` + 불릿) → Known divergences(Resolved / Outstanding / Found by the suite) → Open questions(Decided / Still open) → validTransitions 노트 → Suggested test priority이다. 이 틀을 그대로 쓰고, 영어로 이어서 쓴다.

### 4.1 구조 변경

1. **Cross-cutting rules**
   - 규칙 1 수정: 로깅(errorHandler만 error 레벨, 500일 때 정확히 한 번. 접근 로그는 info).
   - 규칙 5 보강: 신규 리소스(마일스톤, 정산, 대화방, 포트폴리오, 경력)의 소프트 삭제 적용 범위와, 신규 라우트는 행위자의 `deletedAt`을 확인한다는 문장.
   - 규칙 6 보강: 원자성 목록에 수락(마일스톤/대화방 생성 포함), 계획 교체, 결제 confirm(마일스톤 FUNDED), 승인(정산 항목, 계약 완료), 정산 배치, 지급, `notify` + 이메일 enqueue를 추가.
   - 규칙 7 수정: 지연 + 예약 스윕.
   - 규칙 3 수정(P1): "body validation may still precede existence"의 예시가 `PATCH /api/contracts/:id`인데 그 라우트는 이제 항상 410이다. 예시를 `PATCH /api/projects/:projectId/applications/:appId`(잘못된 status + 없는 프로젝트 → 400)로 바꾸고 Q15 본문도 같은 예시로 고친다. 같은 Phase에서 "Note on validTransitions"의 `completeContract` 언급을 "approving the last milestone"으로, Notifications 절의 "`type` is one of 4" 문장을 정책 표 참조로 고친다.
   - 신설 **규칙 9 Request IDs and logging**, **규칙 10 Rate limiting**(429 envelope, `Retry-After`, 키의 IP = `req.ip`이고 `TRUST_PROXY`가 있으면 `X-Forwarded-For`에서 신뢰 프록시를 뺀 값, Next 프록시 두 곳이 그 헤더를 넘긴다는 점), **규칙 11 Background jobs and time**(작업은 상태 변경과 같은 트랜잭션에서 enqueue, 핸들러 멱등, 테스트는 `runDueJobs({ now })`로 구동, KST 규칙), **규칙 12 Conventions of expansion domains**(zod 메시지 형식 `field: message`, 빈 쿼리는 없음으로 처리, 반복/소수 파라미터 400, 정수 금액, `requireActiveUser`, 첨부 업로드의 413/400).
2. **리소스 절**: 기존 절은 같은 자리에서 고친다(Contracts, Payments, Applications 수락, Notifications, Users `GET /:id`, Auth login, Projects analyze). 신규 절은 Notifications 절 뒤, Known divergences 앞에 아래 순서로 넣는다.
   `## Money and milestone rules` → `## Milestones` → `## Settlements` → `## Payout account` → `## Conversations` → `## Portfolio and careers` → `## Profile completion and recommendations` → `## Notification preferences and email` → `## Background jobs`(작업 타입 표: type, enqueue 시점, runAt, dedupeKey, 핸들러 조건, 영향) → `## Internal endpoints`.
   각 신규 절의 상태 기계는 기존 `PATCH /:id/status` 절처럼 From/To 표로 쓴다. 숫자 규칙(수수료, 기한, 개수)은 "Money and milestone rules"와 각 절의 불릿에 적고 예시 계산을 하나 이상 넣는다.
3. **바뀐 기존 동작 표시**: 새 절 `## Expansion changes to pre-existing behavior`를 Known divergences 바로 앞에 두고 표로 관리한다.

   | ID | Area | Before | Now | Tests |
   |---|---|---|---|---|
   | **C1** | Payments | one payment per contract, `contractId` | one payment per milestone, `milestoneId`, sequential funding | `payments.test.ts` |
   | **C2** | Accept application | 5 writes | + default milestone (P1) + conversation & system message (P2A) | `applications.test.ts` |
   | **C3** | Contract completion | client `PATCH` after payment | automatic on last approval; `PATCH` → 410 | `contracts.test.ts`, `milestones.test.ts` |
   | **C4** | Contract shape | `payment` | `milestones[]`, `milestoneSummary` | |
   | **C5** | Signing | both flags → ACTIVE | + valid plan; notifies both | |
   | **C6** | Lifecycle | lazy only | lazy + scheduled | `jobs.test.ts` |
   | **C7** | Logging | `console.error` on 500 | structured logger, same rule | `payments.test.ts` (logging block) |
   | **C8** | Login / analyze | unlimited | 429 | `rate-limit.test.ts` |
   | **C9** | Notifications | 4 types, always in-app | policy table, preferences, email | `notifications.test.ts` |
   | **C10** | Public profile | — | + portfolio, careers, careerSummary | `users.test.ts` |

   본문에서는 바뀐 불릿 끝에 **[C*n*]**을 붙인다(D/Q 표기와 같다). 테스트 이름에도 `[C1]`처럼 태그를 붙여 추적할 수 있게 한다. 이전 동작을 본문에 남겨 두지는 않는다. 본문은 언제나 "현재 의도"이고, 이전 동작은 C 표에만 남긴다.
4. **Known divergences 유지**
   - 기존 D번호는 바꾸지 않는다. 결제/계약 경로가 바뀐 D8, D12, D13, D14, D18, D21은 **Issue/Current 문구를 새 경로 기준으로 고치고**(예: D13 "`Payment.milestoneId` is unique and `createPayment` does not catch P2002"), 행 끝에 `(re-pinned in P1)`을 붙인다. D21의 `completeContract` 부분은 "completion now goes through `POST /api/milestones/:id/approve`, which filters `deletedAt` — D21 remains for `getContract` and `signContract`"로 줄인다.
   - 신규 도메인에서 구현이 명세와 다르면 **D22부터** 이어서 번호를 매기고 Outstanding에 넣는다. 테스트는 `it.fails(... [D22])`이다. 신규 도메인은 명세대로 구현하는 것이 기본이므로 D가 생기면 왜 남기는지 한 줄을 붙인다.
   - 테스트를 쓰다 발견한 미분류 이슈는 기존처럼 "Found by the suite, not yet numbered" 표에 `[unlisted]`로 넣는다.
   - 열린 질문은 **Q21부터**다. 예정된 것: Q21 "message/deliverable attachments are public-bucket URLs" (§6.1-2), Q22 "payout account numbers stored in plaintext" (§6.1-3). 둘 다 확정된 현재 의도이고 명세와 구현이 같으므로 **D번호를 붙이지 않는다**.
5. **Suggested test priority**: 맨 위에 "milestone approval race (manual vs auto) and settlement arithmetic"을 추가하고, 기존 3번(payment state machine)을 마일스톤 기준으로 고친다.

### 4.2 도메인별 명세 작성 체크리스트

각 신규 엔드포인트 절에는 다음을 빠짐없이 적는다. 테스트 작성자가 코드를 보지 않고도 테스트를 쓸 수 있어야 한다.
- 역할, 소유권, 존재 검사의 순서와 각 상태 코드(규칙 3의 "ownership after existence"를 따른다)
- body/query 검증 항목과 400 조건, 경계값(예: 반려 사유 정확히 10자는 통과, 9자는 400)
- 상태 전제와 409/400 구분(상태 충돌은 409, 입력 문제는 400)
- 트랜잭션에 묶이는 모든 쓰기(enqueue와 알림 포함)
- 생성되는 알림 type과 수신자, enqueue되는 작업 type과 runAt
- 응답 형태(최상위 키)

---

## 5. 마무리 단계 (Phase 4)

### 5.1 시드 (`prisma/seed.js`, CommonJS 유지)

각 Phase에서 시드를 깨지지 않게 최소한으로 고치고(P1은 필수), P4에서 시연용 데이터를 완성한다. 삭제 순서(`deleteMany`)에 새 모델을 FK 역순으로 추가한다.

| 도메인 | 추가 시드 |
|---|---|
| 마일스톤/정산 | project7(완료, 한도윤, 950만원): 마일스톤 3개(설계 285만 / 개발 475만 / 배포 190만) 전부 APPROVED, 결제 3건 COMPLETED, 정산 항목 3개, Settlement 2건(지난달 PAID 1, 이번 주 SCHEDULED 1). project8(진행중, 박지윤, 550만원): #1 APPROVED(미정산 항목), #2 SUBMITTED round 2(round 1은 반려 사유 포함, `autoApproveAt` = 시드 시각 + 3일. 대응하는 `milestone.autoApprove`와 `…Reminder` Job row를 같이 INSERT), #3 PENDING. **신규 project9**(CLOSED, 윤서아 수락, 계약 PENDING, 마일스톤 계획 2개, 서명 없음): 계획 편집 시연용. 지급 계좌: 한도윤(국민), 박지윤(카카오뱅크). 나머지 프리랜서는 계좌 없음 |
| 메시지 | 계약 3개마다 대화방. project8에는 메시지 12개(파일 첨부 1개 — URL은 placeholder 이미지, 시스템 메시지 4개), 최민호(project8 의뢰인) 기준 안 읽은 메시지 2개 |
| 프로필 | 프리랜서 5명에게 포트폴리오 2~4개(스킬 태그, 일부 이미지 URL), 경력 1~3개(재직 중 1개 이상) |
| 알림 채널 | 박지윤: `MILESTONE_FUNDED` 이메일 off, `SETTLEMENT_SCHEDULED` 이메일 on. `EmailDelivery` SENT 3건 |
| 작업 큐 | 반복 작업은 시드하지 않는다(워커가 시작할 때 `ensureRecurringJobs`로 만든다). 위의 마일스톤 Job row만 넣는다. 시드의 Job payload 형식은 `src/jobs/types.ts`와 중복되므로 주석으로 출처를 남긴다 |

`docs/SEED_DATA.md`: 프로젝트 표에 project9 추가, "기타 데이터"를 도메인별 소절(마일스톤/결제, 정산/계좌, 대화, 포트폴리오/경력, 알림 설정)로 다시 쓰고, 시연 시나리오(예: "choi@example.com(최민호, project8 의뢰인)으로 로그인 → project8 계약 → 마일스톤 2 승인 → 계약 완료 대신 #3 결제 대기 확인")를 3개 넣는다.

### 5.2 문서

| 문서 | 내용 |
|---|---|
| `docs/API.md` | 기존 표 형식으로 신규 엔드포인트 전부(마일스톤, 정산, 지급 계좌, 계약 목록, 대화, 포트폴리오, 경력, 추천, 알림 설정, 내부 작업). 결제/계약 행 수정(410 표기 포함). 기존에 빠져 있던 bookmarks, notifications 행도 이 기회에 넣는다 |
| `docs/DATABASE.md` | 모델 목록(상태 흐름 포함): Milestone, MilestoneSubmission, MilestoneAttachment, SettlementItem, Settlement, PayoutAccount, Conversation, ConversationParticipant, Message, MessageAttachment, PortfolioItem, Career, NotificationPreference, EmailDelivery, Job, RateLimitCounter. 불변식(계약↔결제 1:N, 마일스톤↔결제 1:1, 마일스톤↔정산항목 1:1, 계약↔대화방 1:1). 백필 메모(과거 완료 계약은 정산 원장 없음). Project 흐름 문구는 실제(OPEN → CLOSED → COMPLETED, IN_PROGRESS 미사용, Q5)로 바로잡는다 |
| `docs/ENV.md` | `LOG_LEVEL`, `TRUST_PROXY`, `RATE_LIMIT_ENABLED`, `INTERNAL_JOB_TOKEN`, `JOB_WORKER_ENABLED`, `JOB_POLL_INTERVAL_MS`, `MILESTONE_AUTO_APPROVE_DAYS`, `EMAIL_PROVIDER`, `EMAIL_FROM` |
| `docs/DEPLOYMENT.md` | 운영(Vercel)에는 워커가 없다는 점, 내부 엔드포인트와 토큰, 외부 스케줄러 미정(§6.1-1)이라 그 전까지 자동 승인·정산·이메일이 돌지 않는다는 점, Vercel 요청 본문 한도 4.5MB 때문에 큰 첨부(최대 10MB × 5)가 운영에서 막힌다는 점 |
| `CLAUDE.md` | "코드에서 추론할 수 없는 것"만 고친다. (1) 작업 큐: 트랜잭션 안에서 enqueue, P2002 대신 `skipDuplicates`, 테스트는 `runDueJobs({now})`, 개발 워커는 `index.ts`에서 시작하고 운영에는 없음. (2) 지연 스윕과 예약 스윕이 공존한다(GET이 여전히 쓴다). (3) 서비스 레이어/zod/`requireActiveUser`/첨부 업로드는 신규 도메인에만 있다는 의도된 혼재와 기존 컨트롤러를 리팩터링하지 말라는 지시. (4) 알림은 반드시 `notify()`를 거친다(직접 `notification.create` 금지, 설정과 이메일이 빠진다). 기존 지점의 문구는 인라인이다. (5) 금액 규칙은 `lib/money.ts`만 쓰고 KST 고정 오프셋을 쓴다. (6) `/api/users` 이중 마운트 순서. (7) 공개 라우트 수와 `req.user` 경고 갱신. (8) 결제가 마일스톤 단위라는 점과 계약 완료가 자동이라는 점. (9) 로거 레벨 규칙(error는 errorHandler만). (10) 새 테스트 헬퍼(`helpers/jobs.ts`)와 Supabase mock 방식. Data model 문단의 1:1 불변식 문장을 고친다 |
| `workbridge-client/src/components/layout/Header.jsx` | 드롭다운에 프리랜서용 "추천 프로젝트"(`/my/recommendations`) 링크 추가. P2에서는 헤더를 p2a-client만 고쳤기 때문에 여기서 한다 |
| `.claude/skills/run-workbridge` | `drive.sh` 스모크에 `/my/contracts`, `/messages`, `/settlements` 스크린샷을 추가할지 P4 워커가 판단한다(선택) |

### 5.3 최종 검증

1. 깨끗한 클론 상태에서 서버 `npm ci` → `prisma generate` → `typecheck` → `prisma validate` → `bash scripts/test-db.sh` → `npm test` 전체 green. `it.fails` 수와 목록을 BEHAVIOR.md Outstanding 표와 대조한다(표에 없는 `it.fails`가 없어야 한다).
2. 클라이언트 `npm ci` → `npm run lint` → `npm run build`.
3. 새 dev DB에 `prisma migrate reset`과 시드, `run-workbridge` 스킬로 기동, 시나리오 3개를 손으로 확인하고 스크린샷을 직접 연다. `npm run jobs:run`으로 시드한 자동 승인 작업이 아직 실행되지 않는지(runAt이 미래), `INTERNAL_JOB_TOKEN`을 설정한 뒤 엔드포인트가 동작하는지 확인한다.
4. `find … | xargs wc -l`로 제품 코드 줄 수를 다시 재서 PROGRESS.md에 기록한다.
5. BRIEF "넣지 않는 것" 점검: CI 변경, Vercel Cron, WebSocket, 실제 메일 연동이 없어야 한다(`git diff main --stat`).

---

## 6. 결정 상태

### 6.1 오케스트레이터가 확정한 결정 (2026-10-21, `docs/expansion/DECISIONS.md`)

처음 계획에서 사람 확인으로 올렸던 네 가지는 모두 기본값으로 확정됐다. 각 도메인의 "결정" 소절에도 반영했다.

1. **운영 환경의 작업 큐 실행 주체는 정하지 않는다.** 내부 엔드포인트 `POST /api/internal/jobs/run`(`INTERNAL_JOB_TOKEN`)과 CLI만 둔다. 외부 스케줄러 연결은 배포와 함께 나중에 정한다. 로컬 개발에서는 `index.ts`가 띄우는 워커가 돈다. P4에서 DEPLOYMENT.md에 "외부 스케줄러가 붙기 전까지 운영에서는 자동 승인, 정산, 이메일이 돌지 않는다"고 적는다(§2.0.8).
2. **첨부 파일은 기존 Supabase 공개 버킷**에 uuid 키로 둔다. 명세와 구현이 다른 것이 아니므로 **D가 아니라 열린 질문 Q21**로 BEHAVIOR.md에 기록한다. signed URL은 버킷 설정 변경이 필요해 나중에 한다(§2.2.6).
3. **지급 계좌번호는 평문 저장, API 응답은 마스킹.** 암호화와 계좌 실명 확인은 나중에 정한다. **열린 질문 Q22**로 기록한다(§2.1.9).
4. **수수료는 승인된 마일스톤 금액의 10%, 수수료에 대한 부가세 10%, 프리랜서 부담, 원 단위 절사**(§2.1.3).

### 6.2 남은 열린 결정

없다. 구현 중 사람(제품 정책, 비용, 외부 서비스)이 정해야 하는 문제가 새로 생기면 오케스트레이터에게 올리고, 그 밖의 것은 워커가 BRIEF 기준으로 정해 DECISIONS.md에 한 줄로 남긴다.
