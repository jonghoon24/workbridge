# 데이터베이스 모델

PostgreSQL(운영은 Supabase) + Prisma. 스키마는 `workbridge-server/prisma/schema.prisma` 한 파일이고, 마이그레이션은 `prisma/migrations/`에 있다. 모델 26개, enum 14개. 제품 규칙과 그 이유는 [domain/](domain/README.md)에 있고, 이 문서는 데이터 구조와 불변식, 잠금을 정리한다.

## 한눈에 보기

```
User ─┬─ Project ── Application ── Contract ─┬─ Milestone ─┬─ Payment
      │     │                                 │             ├─ MilestoneSubmission ── MilestoneAttachment
      │     ├─ ProjectBookmark                │             └─ SettlementItem ── Settlement
      │     └─ PricingAnalysis                ├─ Review
      │                                       └─ Conversation ─┬─ ConversationParticipant (2명)
      ├─ PayoutAccount (0~1)                                   └─ Message ── MessageAttachment
      ├─ AttachmentUpload (붙기 전의 첨부 업로드)
      ├─ PortfolioItem, Career
      ├─ Notification ── EmailDelivery
      └─ NotificationPreference
Job, RateLimitCounter  (FK 없음, 인프라)
```

## 모델

### 사용자와 프로젝트

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **User** | 의뢰인(`CLIENT`) 또는 프리랜서(`FREELANCER`) | `email` unique(앞뒤 공백 없는 소문자로만 저장 — `normalizeEmail`), `password`(OAuth 전용 계정은 null), `googleId` unique, `roleSelected`(OAuth 첫 로그인 역할 선택 여부), 의뢰인 필드 `companyName`/`businessField`/`website`, 프리랜서 필드 `skills String[]`/`activityCategory`/`experienceYears`/`hourlyRate Float`/`portfolioUrl`, `deletedAt`(소프트 삭제) |
| **Project** | 의뢰인이 올린 외주 프로젝트 | `budget Float`, `recruitmentStartDate`, `deadline`, `requiredSkills String[]`, `status`, `deletedAt`. 인덱스 `[status, createdAt]`, `[status, deadline]`, `[status, budget]`, `[clientId]`(아래 "인덱스") |
| **ProjectBookmark** | 프리랜서의 북마크 | `(projectId, userId)` unique |
| **Application** | 프리랜서의 지원 | `expectedRate Float`(계약 금액이 된다), `expectedDuration`, `status`, `(projectId, freelancerId)` unique, 인덱스 `[freelancerId]` |
| **PricingAnalysis** | AI 단가 분석 결과 | `projectId` unique(다시 분석하면 덮어씀), `features Json`, `totalAmount Float` |
| **Review** | 계약 완료 후 상호 리뷰 | `rating` 1~5, `tags String[]`, `(contractId, reviewerId)` unique — 당사자마다 1개, 인덱스 `[revieweeId]` |
| **Notification** | 인앱 알림 | `type String`(TS 유니온, 19종), `title`, `message`, `href`, `readAt`. 인덱스 `[userId, readAt, createdAt]` |

### 계약, 마일스톤, 결제

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **Contract** | 지원 수락으로 생기는 계약 | `projectId` unique, `applicationId` unique, `amount Float`(= `expectedRate`, 소수일 수 있음), `startDate`, `endDate`(마지막 마일스톤 기한), `clientSigned`/`freelancerSigned`, `status`, `completedAt`. 인덱스 `[clientId]`, `[freelancerId]` |
| **Milestone** | 계약을 나눈 작업 단위 | `sequence`(1부터), `amount`(원 단위 정수), `dueDate`(그 KST 날짜의 23:59:59.999), `status`, `fundedAt`, `submittedAt`(최근 제출), `autoApproveAt`(`SUBMITTED`일 때만), `approvedAt`, `approvalType`, `revisionCount`. `(contractId, sequence)` unique, 인덱스 `[status, autoApproveAt]` |
| **MilestoneSubmission** | 산출물 제출 회차 | `round`(1부터), `message`, `links String[]`, `decision`(null = 검수 대기), `decisionReason`, `decidedAt`, `decidedById`(FK 아님, 자동 승인이면 null), `autoDecided`. `(milestoneId, round)` unique |
| **MilestoneAttachment** | 제출 첨부 파일 | `storageKey` unique(비공개 첨부 버킷의 키), `url`(예전 행의 공개 URL, 비공개 버킷이면 null), `fileName`(원래 이름, UTF-8), `mimeType`·`size`(저장된 파일에서 읽은 값). `storageKey`와 `url` 중 하나는 있다(CHECK) |
| **Payment** | 마일스톤 결제 | `contractId`, `milestoneId` unique, `clientId`, `amount Float`(= 마일스톤 금액), `status`, `paymentKey`, `orderId` unique, `confirmStartedAt`(결제 승인 선점 시각, 아래 "동시성"), 인덱스 `[contractId]`, `[clientId]` |

### 정산

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **SettlementItem** | 승인된 마일스톤 하나의 정산 원장 | `milestoneId` unique, `contractId`, `freelancerId`, `settlementId`(null = 미정산), `grossAmount`, `feeRateBps`(승인 시점 요율 스냅샷, 1000 = 10%), `feeAmount`, `feeVatAmount`, `netAmount`, `approvedAt`. 인덱스 `[freelancerId, settlementId]`, `[settlementId]` |
| **Settlement** | 프리랜서별 주간 정산 | `periodStart`(월요일 00:00 KST), `periodEnd`(다음 월요일, 미포함), `scheduledPayoutAt`, `status`, `itemCount`, 금액 합계 4개, `payoutAttempts`(최대 3), 지급 시점 계좌 스냅샷 `bankName`/`accountNumberMasked`/`accountHolder`, `providerReference`, `failureReason`, `paidAt`. `(freelancerId, periodStart)` unique, 인덱스 `[status, scheduledPayoutAt]` |
| **PayoutAccount** | 프리랜서 지급 계좌 | `userId` unique(1인 1계좌), `bankCode`(`lib/banks.ts` 목록), `accountNumber`(숫자만, **암호화해 저장**, 응답에서는 마스킹. 아래 "지급 계좌번호 암호화"), `holderName` |

### 메시지

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **Conversation** | 계약마다 하나인 대화방 | `contractId` unique, `lastMessageAt`(가장 최근 메시지 시각, 메시지가 없으면 null) |
| **ConversationParticipant** | 대화방 참여자 | `(conversationId, userId)` unique, `lastReadAt`(읽음 워터마크: 읽은 상대 메시지 중 가장 최근 것의 `createdAt`). 인덱스 `[userId]` |
| **Message** | 메시지 | `kind`(`TEXT`/`SYSTEM`), `senderId`(SYSTEM이면 null), `systemEvent`(SYSTEM만, bare String), `body`(첨부만 있으면 `''`), `deletedAt`(보낸 사람이 5분 안에 삭제), `createdAt`. 인덱스 `[conversationId, createdAt]` |
| **MessageAttachment** | 메시지 첨부 | `MilestoneAttachment`와 같다: `storageKey` unique, `url`(예전 행만), `fileName`, `mimeType`, `size`, CHECK |
| **AttachmentUpload** | 서명 업로드 URL을 받았지만 아직 메시지·제출에 붙지 않은 파일 | `userId`, `scope`(`MESSAGE`/`MILESTONE_SUBMISSION`), `targetId`(대화방 또는 마일스톤 ID, FK 아님), `storageKey` unique, `fileName`, `mimeType`·`size`(브라우저가 알린 값), `expiresAt`(발급 + 2시간). 붙이는 트랜잭션이 지운다. 만료 행은 `maintenance.cleanup`이 파일과 함께 지운다. 인덱스 `[userId, scope, targetId]`, `[expiresAt]` |

### 프로필 확장

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **PortfolioItem** | 포트폴리오 항목(최대 20) | `title`, `description`, `url`, `imageUrl`, `role`, `skills String[]`(정규화), `startedAt`/`endedAt`(KST 그 달 1일 0시, API에서는 `YYYY-MM`), `sortOrder`. 인덱스 `[userId, sortOrder]` |
| **Career** | 경력(최대 30) | `company`, `position`, `employmentType`, `startDate`, `endDate`(null = 재직 중), `description`. 인덱스 `[userId, startDate]` |

### 알림 채널

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **NotificationPreference** | 사용자별 알림 설정 중 기본값과 **다른 것만** | `type String`, `inApp Boolean?`, `email Boolean?` — null은 "정책 기본값을 따른다". 두 채널이 모두 null이 되면 row를 지운다. `(userId, type)` unique |
| **EmailDelivery** | 이메일 한 통의 발송 기록(감사용) | `notificationId`(같은 `notify()`가 만든 인앱 row, 없으면 null), `type`, `toAddress`(생성 시점 주소), `subject`, `body`, `contextKey`(다이제스트만 `conversation:<id>`), `status`, `attempts`, `provider`, `providerMessageId`, `error`(≤2,000자), `sentAt`. 인덱스 `[userId, type, contextKey, createdAt]`(다이제스트 60분 제한 조회), `[userId, createdAt]`, `[status]`. 읽는 API가 없고 아무것도 지우지 않는다(보관 기간 미정: [#26](https://github.com/jonghoon24/workbridge/issues/26)) |

### 인프라

| 모델 | 설명 | 주요 필드 |
| --- | --- | --- |
| **Job** | Postgres 작업 큐 | `type String`(`src/jobs/types.ts`의 `JobType`), `payload Json`, `status`, `runAt`, `attempts`/`maxAttempts`(기본 5), `lockedAt`/`lockedBy`, `lastError`, `dedupeKey` unique(같은 키로 다시 넣으면 무시), `traceId`(넣은 요청의 request id), `completedAt`. 인덱스 `[status, runAt]`, `[type, status]` |
| **RateLimitCounter** | 고정 윈도 요청 제한 카운터 | PK `(key, windowStart)`, `count`, `expiresAt`. 인덱스 `[expiresAt]`. 만료 행은 `maintenance.cleanup` 작업이 지운다 |

## Enum과 상태 흐름

| Enum | 값과 흐름 |
| --- | --- |
| `Role` | `CLIENT`, `FREELANCER` |
| `ProjectStatus` | `UPCOMING` → `OPEN` → `CLOSED` → `IN_PROGRESS` → `COMPLETED`. 모집 시작일·마감일에 따라 지연 스윕(GET 목록·상세)과 `project.lifecycleSweep` 작업이 `UPCOMING`→`OPEN`→`CLOSED`로 바꾸고, 지원 수락도 `CLOSED`로 만든다. 양측 서명으로 계약이 `ACTIVE`가 되는 트랜잭션이 `CLOSED`→`IN_PROGRESS`, 마지막 마일스톤 승인이 `IN_PROGRESS`→`COMPLETED`로 바꾼다. 의뢰인의 수동 전이(`PATCH /api/projects/:id/status`)는 `UPCOMING`→`OPEN`·`CLOSED`·`CANCELLED`, `OPEN`→`CLOSED`·`CANCELLED`뿐이다. 마이그레이션 `20261110091808_backfill_in_progress_projects`가 계약이 `ACTIVE`인 기존 `CLOSED` 프로젝트를 `IN_PROGRESS`로 옮겼다 |
| `ApplicationStatus` | `PENDING` → `ACCEPTED` / `REJECTED`. 수락하면 같은 프로젝트의 다른 대기 지원은 거절된다. 마감된 프로젝트의 대기 지원도 거절된다 |
| `ContractStatus` | `PENDING`(서명 대기) → `ACTIVE`(양측 서명, 유효한 계획 필요) → `COMPLETED`(마지막 마일스톤 승인 시 자동). 취소·해지 상태는 없다 |
| `MilestoneStatus` | `PENDING` → `FUNDED`(결제) → `SUBMITTED`(제출) → `APPROVED`(최종) 또는 `REVISION_REQUESTED`(반려) → `SUBMITTED`(재제출). 계약이 `PENDING`인 동안 계획 교체가 `PENDING` 마일스톤을 지우고 새로 만든다 |
| `ApprovalType` | `MANUAL`(의뢰인 승인), `AUTO`(제출 7일 뒤 자동 승인) |
| `SubmissionDecision` | `APPROVED`, `REJECTED` (null = 검수 대기) |
| `PaymentStatus` | `PENDING` → `COMPLETED` / `FAILED`(재시도 시 새 `orderId`로 `PENDING`). `REFUNDED`는 읽기만 하고 아무것도 쓰지 않는다(환불 흐름 없음) |
| `SettlementStatus` | `SCHEDULED` → `PROCESSING` → `PAID`. 지급 시점에 계좌가 없으면 `ON_HOLD`(계좌 등록 시 `SCHEDULED`), 이체 실패는 `FAILED`(24시간 뒤 재시도, 3회째 실패는 최종). `PROCESSING`에서 멈춘 정산은 자동으로 다시 시도하지 않는다(이중 지급 방지, 운영자 몫) |
| `MessageKind` | `TEXT`(참여자가 씀), `SYSTEM`(계약·마일스톤 이벤트 기록, 발신자 없음) |
| `EmploymentType` | `FULL_TIME`, `CONTRACT`, `FREELANCE`, `INTERN` |
| `AttachmentUploadScope` | `MESSAGE`, `MILESTONE_SUBMISSION` — 업로드를 붙일 수 있는 대상 |
| `EmailDeliveryStatus` | `PENDING` → `SENT` / `FAILED` / `SKIPPED`(발송 전에 수신자가 탈퇴). 셋 다 최종 |
| `JobStatus` | `PENDING` → `RUNNING` → `SUCCEEDED` / `FAILED`, 실패 후 재시도면 다시 `PENDING`(지수 백오프). `CANCELLED`는 아직 쓰는 곳이 없다 |

`Notification.type`, `NotificationPreference.type`, `EmailDelivery.type`, `Message.systemEvent`, `Job.type`은 DB enum이 아니라 bare `String`이고, 허용 값은 TypeScript 유니온(`src/lib/notifications/types.ts`, `services/messaging.service.ts`, `src/jobs/types.ts`)이 정한다. 값을 더할 때 마이그레이션이 필요 없다.

## 관계와 불변식

| 관계 | 카디널리티 | 강제 방법 |
| --- | --- | --- |
| Project ↔ Contract | 1 : 0..1 | `Contract.projectId` unique |
| Application ↔ Contract | 1 : 0..1 | `Contract.applicationId` unique |
| Contract ↔ Milestone | 1 : 1..10 | `(contractId, sequence)` unique. 개수·합계는 서비스가 검사 |
| **Contract ↔ Payment** | **1 : N** | 마일스톤마다 결제 1건. 확장 전에는 1:1이었다 |
| Milestone ↔ Payment | 1 : 0..1 | `Payment.milestoneId` unique |
| Milestone ↔ MilestoneSubmission | 1 : N | `(milestoneId, round)` unique, 회차는 1부터 연속 |
| Milestone ↔ SettlementItem | 1 : 0..1 | `SettlementItem.milestoneId` unique. 승인 트랜잭션에서 생긴다 |
| Settlement ↔ SettlementItem | 1 : N | 항목은 정산 하나에만 붙는다(조건부 쓰기) |
| User ↔ Settlement | 1 : N | `(freelancerId, periodStart)` unique — 주마다 1건 |
| User ↔ PayoutAccount | 1 : 0..1 | `PayoutAccount.userId` unique |
| Contract ↔ Conversation | 1 : 1 | `Conversation.contractId` unique. 지원 수락 트랜잭션이 만든다 |
| Conversation ↔ ConversationParticipant | 1 : 정확히 2 | `(conversationId, userId)` unique. 계약의 의뢰인과 프리랜서이며 바뀌지 않는다 |
| Contract ↔ Review | 1 : 0..2 | `(contractId, reviewerId)` unique, 계약 `COMPLETED` 뒤에만 |
| User ↔ NotificationPreference | 1 : N | `(userId, type)` unique |
| Conversation ↔ Message | 1 : N | `Message.conversationId`. 인덱스 `[conversationId, createdAt]` |
| Message ↔ MessageAttachment | 1 : 0..5 | `MessageAttachment.messageId`. 개수는 요청 스키마(`uploadIds` 최대 5개)가 검사 |
| MilestoneSubmission ↔ MilestoneAttachment | 1 : 0..5 | `MilestoneAttachment.submissionId`. 개수는 요청 스키마가 검사 |
| Notification ↔ EmailDelivery | 1 : 0..1 | `EmailDelivery.notificationId`(선택, `ON DELETE SET NULL`, unique는 아님 — `notify()`가 인앱 row마다 최대 1건 만든다). 이메일 전용 알림(다이제스트)이면 null |
| User ↔ PortfolioItem | 1 : 0..20 | `PortfolioItem.userId`. 개수는 서비스가 검사 |
| User ↔ Career | 1 : 0..30 | `Career.userId`. 개수는 서비스가 검사 |
| Contract ↔ SettlementItem | 1 : N | `SettlementItem.contractId`. 승인된 마일스톤마다 1건 |

그 밖의 불변식:

- **금액**: 마일스톤 금액 합계 = `Math.round(contract.amount)`. 결제 금액 = 마일스톤 금액. 정산 항목은 `fee = floor(gross × 10%)`, `vat = floor(fee × 10%)`, `net = gross − fee − vat`(정수 연산, `src/lib/money.ts`만 쓴다). 정산 합계는 항목 값을 더한 것이고 합계 gross에서 다시 계산하지 않는다.
- **결제 순서**: 마일스톤은 `sequence` 순서대로만 결제된다.
- **메시지**: `TEXT`는 발신자가 참여자이고 `systemEvent`가 null, `SYSTEM`은 발신자가 null이고 `systemEvent`가 있다. 대화방 안에서 `createdAt`은 커밋 순서대로 엄격히 증가한다(대화방 row를 잠근 뒤 `max(서버 시각, lastMessageAt + 1ms)`, `postMessage`). 커서 폴링과 읽음 워터마크가 이것에 기댄다.
- **활성 계약 계획 잠금**: 계약이 `ACTIVE`가 되면 마일스톤 계획을 바꿀 수 없다.
- **문자열 배열에 `NULL` 원소 없음**: `User.skills`, `Project.requiredSkills`, `MilestoneSubmission.links`, `PortfolioItem.skills`, `Review.tags`는 원소가 모두 문자열이다. DB의 CHECK 제약(`<테이블>_<컬럼>_no_null`, `array_position(<컬럼>, NULL) IS NULL`)이 강제한다. Prisma의 `String[]`은 원소가 모두 문자열이라고 가정해서, `NULL` 원소가 든 행 하나를 읽으면 그 쿼리 전체가 변환 오류(`P2032`)로 실패한다 — 프로젝트 하나 때문에 `GET /api/projects`가 500이 된다. API는 zod가 원소를 검사하므로 만들지 않고, 이 제약은 운영자의 수동 SQL, 백필, 시드를 막는다. Prisma 스키마는 CHECK를 표현하지 못하므로 마이그레이션 SQL에만 있다(`schema.prisma`의 해당 필드 주석 참고). 새 `String[]` 컬럼을 만들면 같은 제약을 함께 건다.

### `Message.sender`의 `onDelete: Restrict`

선택 관계의 Prisma 기본값은 `SetNull`이다. 그대로 두면 사용자 row가 지워질 때 그 사람의 `TEXT` 메시지가 발신자 없는 메시지, 즉 시스템 메시지처럼 보이는 행이 된다(위 "메시지" 불변식 위반). 사용자는 항상 소프트 삭제만 되므로 실제로 지워질 일은 없지만, 하드 삭제를 시도하면 DB가 막도록 `Restrict`를 명시했다.

### 외래 키의 삭제 동작

모든 필수 관계는 `ON DELETE RESTRICT`다. 예외는 선택 관계 두 개뿐이다: `SettlementItem.settlementId`와 `EmailDelivery.notificationId`(`SET NULL`). 그래서 시드처럼 데이터를 지울 때는 자식부터 지워야 한다(`prisma/seed.js`의 `deleteMany` 순서).

### 지급 계좌번호 암호화

`PayoutAccount.accountNumber`는 애플리케이션이 저장 직전에 암호화한다(`src/lib/payoutAccountCrypto.ts`, [#28](https://github.com/jonghoon24/workbridge/issues/28)).
DB를 통째로 읽은 사람(백업, SQL 접근)도 키 없이는 계좌번호를 알 수 없게 하려는 것이다. 키는 DB 밖의 환경변수
`PAYOUT_ACCOUNT_ENCRYPTION_KEY`다([ENV.md](ENV.md), 환경별 키와 교체는 [DEPLOYMENT.md](DEPLOYMENT.md#지급-계좌-암호화-키)).

- 형식: `v1:<iv>:<tag>:<암호문>`(각 부분 base64url). AES-256-GCM, 쓸 때마다 새 12바이트 IV, 16바이트 인증 태그.
  접두어 `v1`이 키를 가리킨다 — 키를 바꿀 때 새 버전을 더하고 옛 버전은 읽기용으로 남긴다.
- 추가 인증 데이터(AAD)는 그 행의 `userId`다. 다른 사용자 행에 암호문을 옮겨 붙이면 복호화가 실패한다(다른 사람의 정산금이
  그 계좌로 나가지 않는다). 잘못된 키, 변조된 값, 모르는 형식도 틀린 번호 대신 오류가 된다.
- 복호화는 응답의 마스킹(`serializePayoutAccount`)과 지급 결정(사용자 행 잠금 안에서, 정산 스냅샷의 마스킹과 이체 요청)에서만 한다.
  정산 행(`Settlement.accountNumberMasked`)에는 처음부터 마스킹한 값만 남는다.
- **암호화 전에 저장된 행**은 숫자 그대로다(10~14자리). 서버는 이것도 그대로 읽고, 계좌를 다시 저장하면 암호화한다. 남은 평문
  행은 한 번 돌리는 백필 `npm run payout:encrypt-accounts`(원격은 `.github/workflows/payout-encrypt.yml`)가 암호화한다.
  SQL 마이그레이션으로는 키를 쓸 수 없어서 스크립트다. 행마다 사용자 행을 잠그고, 읽은 평문이 그대로일 때만 바꾸므로 서비스 중에
  돌려도 되고 여러 번 돌려도 된다.
- 시드(`prisma/seed.js`)는 `prisma/payoutAccountCrypto.js`(같은 형식의 CommonJS 사본)로 암호화해 넣는다. 두 구현이 같은지는
  `test/payout-account-crypto.test.ts`가 시드 쪽 출력을 서버 코드로 복호화해 확인한다.

### 행 단위 보안

Supabase는 `public` 스키마를 Data API(PostgREST)로 공개한다. 그래서 RLS가 꺼진 테이블은 프로젝트 URL과 anon(publishable) 키만
있으면 누구나 읽고 쓸 수 있다. 앱은 Data API를 쓰지 않는다. 서버는 Prisma로 테이블 소유자 역할로 접속하고(소유자는 RLS를 우회한다),
Storage는 secret 키로만 다룬다. 그래서 **모든 테이블에 RLS를 켜고 정책은 두지 않는다**. anon·authenticated 역할은 아무 행도 보지
못하고, 앱 동작은 바뀌지 않는다(`20261111024733_enable_row_level_security`, `_prisma_migrations` 포함). 이 마이그레이션은
마이그레이션 역할이 소유하지 않은 테이블(확장이 만든 테이블 등)을 건너뛰고 `NOTICE`만 남긴다. 그런 테이블은 대시보드에서 따로 확인한다.

- 새 테이블은 그 테이블을 만드는 마이그레이션에서 RLS를 켠다. `--create-only`로 만든 SQL 끝에
  `ALTER TABLE "<Model>" ENABLE ROW LEVEL SECURITY;`를 붙인다(`db-migration` 스킬). 빠뜨리면 `test/db-constraints.test.ts`의
  "row level security"가 실패하고, Supabase Security Advisor에 "RLS Disabled in Public"이 뜬다.
- 정책을 만들지 않으므로 `FORCE ROW LEVEL SECURITY`는 쓰지 않는다. 쓰면 소유자인 앱도 막힌다.

## 인덱스

인덱스는 실제로 도는 쿼리에 맞춰 단다. 유니크 제약(`@unique`, `@@unique`)은 자체 인덱스가 있으므로 따로 달지 않는다. 확장 도메인 모델의 인덱스는 위 모델 표에 적었고, 기존 도메인의 목록 쿼리와 외래 키 쪽 인덱스는 다음과 같다(`20261108143952_add_list_and_foreign_key_indexes`).

| 인덱스 | 쓰는 쿼리 |
| --- | --- |
| `Project[status, createdAt]` | `GET /api/projects` 기본 목록: `status`(기본 `OPEN`) 필터 + `createdAt desc` 정렬(`sort=latest`) |
| `Project[status, deadline]` | `GET /api/projects?sort=deadline`(`deadline asc`). 지연 스윕 `closeExpiredOpenProjects`의 `status IN (UPCOMING, OPEN) AND deadline < now`와 `status = UPCOMING AND deadline >= now`도 이것을 쓴다 |
| `Project[status, budget]` | `GET /api/projects?sort=budget`(`budget desc`)와 `minBudget`/`maxBudget` 범위 필터 |
| `Project[clientId]` | `GET /api/users/me/projects`(의뢰인의 프로젝트) |
| `Application[freelancerId]` | `GET /api/users/me/applications`와 그 앞의 마감 지원 일괄 거절(`freelancerId` 조건) |
| `Contract[clientId]`, `Contract[freelancerId]` | `GET /api/contracts`의 `OR [{ clientId }, { freelancerId }]` — 두 인덱스를 bitmap OR로 합친다 |
| `Payment[clientId]` | `GET /api/payments`(의뢰인의 결제 내역) |
| `Review[revieweeId]` | `GET /api/reviews/users/:id`, 공개 프로필과 추천의 평균 평점(`receivedReviews`) |

- `deletedAt`은 인덱스에 넣지 않았다. 거의 모든 행이 `null`이라 거르는 힘이 없다.
- 일부러 달지 않은 것: `Project.category`(값이 몇 개뿐이라 선택도가 낮다. `status` 인덱스로 읽은 뒤 거른다), `requiredSkills`의 GIN(`hasSome` 기술 검색. 프로젝트 수가 늘어 기술 필터가 느려지면 단다), 제목·설명 검색 `ILIKE '%…%'`(일반 B-tree로는 안 된다. 커지면 `pg_trgm` GIN).
- 인덱스는 일반 `CREATE INDEX`로 만든다. 만드는 동안 그 테이블의 쓰기가 잠깐 막히지만 지금 행 수에서는 순간이다. 테이블이 커진 뒤 새 인덱스를 달 때는 `--create-only`로 만든 SQL을 `CREATE INDEX CONCURRENTLY`로 바꾸는 것을 검토한다.

## 소프트 삭제

- `User`와 `Project`만 `deletedAt`으로 소프트 삭제한다. **모든 조회와 쓰기에 `deletedAt: null`을 건다.**
- 확장 리소스는 계약의 프로젝트를 따른다: 프로젝트가 삭제된 계약·마일스톤·대화방은 확장 라우트에서 404이고 목록에서 빠진다. 예외로 정산과 지급 계좌는 프로젝트 삭제와 무관하게 보이고 지급되며, 자동 승인도 진행한다(이미 결제된 돈을 묶지 않는다).
- 쓰기 라우트와 확장 라우트는 호출자도 다시 확인한다(`requireActiveUser`, 삭제된 사용자는 401).
- 포트폴리오와 경력은 하드 삭제한다. 사용자가 소프트 삭제되면 보이지 않을 뿐 남아 있다.
- 메시지의 `deletedAt`은 사용자의 "보낸 메시지 삭제"다. 메시지와 첨부 행은 남고 API는 내용 없는 표시(tombstone)로 돌려준다. 비공개 버킷의 첨부 파일은 `attachment.deleteObjects` 작업이 지운다.

## 시각과 시간대

- 모든 `DateTime`은 Prisma 기본인 `timestamp(3)`(시간대 없음)에 UTC로 저장된다.
- 날짜 규칙은 KST(UTC+9 고정)로 계산한다: 마일스톤 기한은 그 날짜의 23:59:59.999 KST, 포트폴리오·경력의 월은 KST 그 달 1일 0시, 정산 주차는 월요일 0시 KST부터.
- raw SQL에 시각을 넘길 때는 `'<ISO>'::timestamp(3)`로 넘긴다(`src/lib/sql.ts`). `Date`를 그대로 넘기면 세션 시간대(로컬 PG는 Asia/Seoul) 때문에 9시간 어긋난다.

## 동시성: 잠금과 조건부 쓰기

상태 전이는 기대 상태를 조건으로 거는 `updateMany`이고, 진 쪽은 409 또는 no-op이다. 여러 행을 한 번에 바꾸는 흐름은 raw SQL `SELECT … FOR UPDATE`로 행을 먼저 잠근다.

| 잠그는 행 | 쓰는 곳 |
| --- | --- |
| `Contract` | 마일스톤 계획 교체, 승인(수동·자동 — 마지막 두 마일스톤 동시 승인 직렬화) |
| `Project` | 프로젝트 삭제(완료되지 않은 계약 확인과 소프트 삭제를 한 잠금 안에서), 지원 수락(트랜잭션의 첫 문장 — 같은 프로젝트의 수락을 한 번에 하나로 직렬화) |
| `User`(프리랜서 본인) | 지급 계좌 PUT/DELETE, 지급 결정, 주간 정산 배치(프리랜서마다), 포트폴리오 생성·삭제·순서 변경, 경력 생성, 알림 설정 PUT |
| `Conversation` | 메시지·시스템 메시지 게시(항상 이벤트 트랜잭션의 마지막 쓰기) |
| `ConversationParticipant` | 읽음 처리, 미확인 메시지 다이제스트 |

**결제 승인은 잠금 대신 선점(조건부 쓰기)으로 직렬화한다.** 토스페이먼츠 호출을 트랜잭션 안에 두지 않으려고, 승인 요청은
공급자를 부르기 전에 `status = PENDING`이고 `confirmStartedAt`이 비었거나 60초보다 오래된 결제에만 `confirmStartedAt = now`를
쓴다. 쓰지 못한 요청은 409다. 60초 임대는 중간에 죽은 요청이 그 주문을 영원히 막지 않게 하려는 것이다. 토스 호출은 30초 타임아웃이라 살아 있는 요청의 선점은 호출 중에 끝나지 않는다. 실패한 결제를
다시 만들면(`POST /api/payments`) 선점도 지운다.

잠금 순서는 `Contract` → `Milestone` → 이벤트의 다른 쓰기 → `Conversation`이다. 대화방 시스템 메시지
(`postSystemMessage`, `src/services/messaging.service.ts`)는 언제나 이벤트 트랜잭션의 **마지막 쓰기**라서
(`MILESTONE_APPROVED` 다음 `CONTRACT_COMPLETED`처럼) `Conversation` 잠금을 가장 늦게 잡고, 대화방을 잠근 트랜잭션이
그 뒤에 계약·마일스톤·프로젝트를 잠그는 일이 없다. 그래서 대화방 잠금은 다른 잠금과 순환을 만들지 않는다. 새 이벤트에
시스템 메시지를 붙일 때도 마지막에 부른다. 지원 수락은 다른 무엇보다 먼저 `Project`를 잠근다. 그러지 않으면 같은
프로젝트의 두 수락이 각자 자기 지원을 잠근 뒤 상대의 지원을 거절하려고 서로 기다려 교착한다(`40P01`). 예외로 결제 확인과 dev-complete는 `Payment`를 `Milestone`보다 먼저 쓴다.
`ConversationParticipant`는 다른 잠금과 함께 잡지 않는다.

정산은 `User` → `Settlement` 순서다. 지급 결정과 주간 정산 배치(`settleFreelancer`) 모두 프리랜서의 사용자 행을
트랜잭션의 첫 문장으로 잠근 뒤 정산 행을 조건부 쓰기로 잡는다. 배치가 정산 행부터 잡으면 교착한다([#79](https://github.com/jonghoon24/workbridge/issues/79)에서 고침):
배치가 같은 트랜잭션에서 정산 행을 두 번째로 `UPDATE`할 때 Postgres는 자기 트랜잭션이 만든 행 버전이라 FK 검사를
생략하지 않고 `Settlement.freelancerId → User`에 `FOR KEY SHARE`를 요청하는데, 그 사용자 행을 쥔 지급 결정이 정산 행을
기다리고 있기 때문이다. 같은 트랜잭션에서 한 행을 두 번 쓰면 FK가 가리키는 부모 행도 잠긴다는 점을 잠금 순서에 넣어 둔다.

**계약 서명은 `FOR UPDATE` 없이 직렬화된다.** `prisma.contract.update`는 `UPDATE … RETURNING` 한 문장으로 컴파일되어
그 행의 잠금을 잡는다. 두 당사자가 동시에 서명하면 두 번째 `UPDATE`가 첫 번째의 커밋을 기다린 뒤 커밋된 값 위에
쓰고 돌려주므로, 나중 서명자가 두 플래그가 모두 켜진 것을 보고 계약을 `ACTIVE`로 만든다(동시 서명 15쌍으로 확인).
`signContract`가 서명과 활성화를 한 트랜잭션에 묶은 것은 경합 때문이 아니라, 두 문장 사이에서 실패하면 서명만 되고
활성화되지 않은 계약이 남기 때문이다. 활성화는 `status = PENDING`일 때만 한다.

## 금액이 `Float`인 부채

`Project.budget`, `Application.expectedRate`, `Contract.amount`, `Milestone.amount`, `Payment.amount`, 정산 금액들, `User.hourlyRate`, `PricingAnalysis.totalAmount`가 모두 `Float`(double)이다. 확장 이전부터 있던 부채이고 일부러 고치지 않았다. 대신 다음 규칙으로 오차를 막는다.

- 확장 도메인은 원 단위 정수만 쓴다. 소수 금액 입력은 400.
- 계약 금액은 지원의 `expectedRate`라 소수일 수 있다. 마일스톤 관련 계산(기본 마일스톤, 계획 합계, 서명 때의 계획
  검사)은 `Math.round(contract.amount)`(0.5는 올림, `wholeWon()`)를 쓴다.
- **SQL에서 금액을 반올림할 때는 `ROUND(x::numeric)`을 쓴다.** Postgres의 `round()`는 `float8`에서 0.5를 짝수 쪽으로
  보내서(`2500000.5` → `2500000`) `Math.round`(`2500001`)와 1원 어긋난다. 이렇게 만든 마일스톤 계획은 합계가
  `Math.round(contract.amount)`와 달라 서명 때의 계획 검사에서 거절된다. `numeric`의 `ROUND`는 양수의 0.5를 올린다.
- 수수료 계산은 basis point 정수 연산이라 부동소수 오차가 없다.

## 마이그레이션과 백필 메모

| 마이그레이션 | 내용 |
| --- | --- |
| `20260312030411_init` ~ `20260512003000_normalize_skill_taxonomy` | 확장 이전 스키마(역할 선택, 활동 분야, `UPCOMING` 상태, 북마크, 알림, 모집 시작일, 스킬 정규화 등) |
| `20261021042048_expansion_job_queue_rate_limit` | `Job`, `RateLimitCounter` |
| `20261021060000_expansion_milestones_settlement` | 마일스톤·제출·첨부·정산·지급 계좌, `Payment` 1:N 전환 |
| `20261021062933_expansion_messaging_profile` | 대화방·참여자·메시지·첨부, 포트폴리오, 경력 |
| `20261021071341_expansion_notification_channels` | 알림 설정, 이메일 발송 기록 |
| `20261108143952_add_list_and_foreign_key_indexes` | 인덱스만 추가: `Project` 4개, `Application[freelancerId]`, `Contract[clientId]`·`[freelancerId]`, `Payment[clientId]`, `Review[revieweeId]`("인덱스" 참고). 데이터 변경 없음 |
| `20261110082231_array_columns_reject_null_elements` | 문자열 배열 컬럼 5개에 `NULL` 원소를 막는 CHECK 제약("관계와 불변식"). 제약을 걸기 전에 이미 있던 `NULL` 원소를 `array_remove`로 지운다(원소만 지우고 행과 나머지 원소는 그대로) |
| `20261110082927_add_payment_confirm_started_at` | `Payment.confirmStartedAt`(nullable) 추가. 기존 행은 null(선점 없음). 데이터 변경 없음 |
| `20261110084919_normalize_user_email` | 데이터만: 모든 `User.email`(탈퇴 포함)을 앞뒤 공백 제거 + 소문자로 바꾼다. 정규화하면 같아지는 주소가 둘 이상이면 아무것도 바꾸지 않고 이유를 밝히며 실패한다(어느 계정을 남길지는 사람이 정한다). 스키마 변경 없음 |
| `20261110090000_private_attachment_storage` | 첨부를 비공개 버킷으로: `MessageAttachment`·`MilestoneAttachment`에 `storageKey`(unique), `url`을 nullable로, 둘 중 하나는 있어야 하는 CHECK. `AttachmentUpload`와 `AttachmentUploadScope`. 데이터 변경 없음(예전 행은 공개 URL 그대로, 이전은 `scripts/migrate-legacy-attachments.ts`) |
| `20261111024733_enable_row_level_security` | 스키마의 모든 테이블(`_prisma_migrations` 포함)에 RLS를 켠다. 정책은 없다("행 단위 보안"). 스키마·데이터 변경 없음 |

- **기본 마일스톤 백필**: 확장 전에 있던 계약마다 마일스톤 1개(`전체 작업`, 금액 `ROUND(amount::numeric)`, 기한 = 계약 `endDate`)를 만들었다. 완료 계약이면 `APPROVED`(`MANUAL`), 결제가 완료됐으면 `FUNDED`, 나머지는 `PENDING`. float를 그대로 반올림하면 1원 어긋나므로 numeric으로 바꿔 반올림한다(위 "금액이 `Float`인 부채"). 기존 결제는 그 마일스톤에 연결했고, 미완료 결제의 금액은 마일스톤 금액으로 맞췄다. 완료 계약의 `completedAt`은 알 수 없어 `createdAt`으로 채웠다.
- **정산 원장은 확장 이후 승인분부터다.** 확장 전에 완료된 계약의 마일스톤에는 `SettlementItem`이 없다(화면의 예상 정산액은 현재 요율로 계산해 보여준다).
- **대화방 백필**: 확장 전 계약마다 대화방과 참여자 둘을 계약의 `createdAt`으로 만들었다. 메시지(시스템 메시지 포함)는 백필하지 않았다.
- **알림 설정**: 희소 저장이라 백필이 없다. row가 없으면 기본값이다.
