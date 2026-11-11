# 데이터베이스 불변식과 잠금

PostgreSQL(운영은 Supabase) + Prisma. 모델·필드·enum·인덱스의 원본은 `workbridge-server/prisma/schema.prisma`(필드 주석 포함)이고,
마이그레이션은 `prisma/migrations/`에 있다. 제품 규칙과 상태 전이는 [domain/](domain/README.md)에 있다. 이 문서는 스키마만 읽어서는
보이지 않는 것, 즉 DB 밖에서 지키는 불변식, 스키마가 표현하지 못하는 제약, 잠금 순서, 알고 있는 부채를 정리한다.

## 한눈에 보기

```
User ─┬─ Project ── Application ── Contract ─┬─ Milestone ─┬─ Payment
      │     │                                 │             ├─ MilestoneSubmission ── MilestoneAttachment
      │     └─ ProjectBookmark                │             └─ SettlementItem ── Settlement
      │                                       ├─ Review
      │                                       └─ Conversation ─┬─ ConversationParticipant (2명)
      ├─ PayoutAccount (0~1)                                   └─ Message ── MessageAttachment
      ├─ AttachmentUpload (붙기 전의 첨부 업로드)
      ├─ PortfolioItem, Career
      ├─ Notification ── EmailDelivery
      └─ NotificationPreference
Job, RateLimitCounter  (FK 없음, 인프라)
```

`Notification.type`, `NotificationPreference.type`, `EmailDelivery.type`, `Message.systemEvent`, `Job.type`은 DB enum이
아니라 bare `String`이고, 허용 값은 TypeScript 유니온(`src/lib/notifications/types.ts`, `services/messaging.service.ts`,
`src/jobs/types.ts`)이 정한다. 값을 더할 때 마이그레이션이 필요 없다.

## 관계와 불변식

유니크 제약으로 강제되는 카디널리티(계약은 지원마다 하나, 결제와 정산 항목은 마일스톤마다 하나, 리뷰는 당사자마다 하나,
정산은 프리랜서·주차마다 하나 등)는 `schema.prisma`의 `@unique`/`@@unique`가 원본이다. 예외로 **철회되지 않은 계약은
프로젝트마다 하나**라는 제약은 부분 유니크 인덱스라 마이그레이션 SQL에만 있다(아래 "스키마가 표현하지 못하는 제약").
아래는 DB가 강제하지 않고 애플리케이션이 지키는 것이다.

- **개수 한도**: 계약당 마일스톤 수(`MAX_MILESTONES`, `src/lib/money.ts`), 메시지·제출당 첨부 수(`ATTACHMENT_MAX_FILES`,
  요청 스키마), 포트폴리오·경력 수(서비스)는 DB 제약이 없다. 포트폴리오·경력 개수는 사용자 행 잠금으로 동시 생성을 막는다.
- **제출 회차**는 마일스톤마다 1부터 연속이다. **대화방 참여자**는 계약의 의뢰인과 프리랜서 정확히 둘이고 바뀌지 않는다.
  대화방은 지원 수락 트랜잭션이 만든다. **리뷰**는 계약이 `COMPLETED`된 뒤에만 쓴다.
- **정산 항목**은 정산 하나에만 붙는다(조건부 쓰기).
- **금액**: 마일스톤 금액 합계 = `wholeWon(contract.amount)`, 결제 금액 = 마일스톤 금액. 정산 합계는 항목 값을 더한 것이고
  합계 gross에서 다시 계산하지 않는다(계산은 `src/lib/money.ts`, 규칙과 이유는 [milestones-payments.md](domain/milestones-payments.md)).
- **결제 순서**: 마일스톤은 `sequence` 순서대로만 결제된다. **활성 계약 계획 잠금**: 계약이 `ACTIVE`가 되면 마일스톤 계획을 바꿀 수 없다.
- **메시지**: `TEXT`는 발신자가 참여자이고 `systemEvent`가 null, `SYSTEM`은 발신자가 null이고 `systemEvent`가 있다.
  대화방 안에서 `createdAt`은 커밋 순서대로 엄격히 증가한다. 메시지를 넣는 `postMessage`가 대화방 행을 잠근 뒤, 서버 시각과
  `lastMessageAt + 1ms` 중 늦은 값을 `createdAt`으로 쓰기 때문이다. 커서 폴링과 읽음 워터마크가 이 순서에 기댄다.

### 스키마가 표현하지 못하는 제약

Prisma 스키마는 CHECK를 표현하지 못해서 아래 제약은 마이그레이션 SQL에만 있다.

- **문자열 배열에 `NULL` 원소 없음**: `String[]` 컬럼마다 `<테이블>_<컬럼>_no_null`(`array_position(<컬럼>, NULL) IS NULL`)
  CHECK가 있다(`schema.prisma`의 해당 필드 주석, `test/db-constraints.test.ts`). Prisma는 `String[]`의 원소가 모두 문자열이라고 가정해서, `NULL` 원소가 든 행
  하나를 읽으면 그 쿼리 전체가 변환 오류(`P2032`)로 실패한다 — 프로젝트 하나 때문에 `GET /api/projects`가 500이 된다. API는
  zod가 원소를 검사하므로 만들지 않고, 이 제약은 운영자의 수동 SQL, 백필, 시드를 막는다. 새 `String[]` 컬럼도 같은 이유로
  같은 제약이 필요하다.
- **첨부의 위치**: `MessageAttachment`·`MilestoneAttachment`는 `storageKey`(비공개 버킷)와 `url`(비공개 버킷 이전의 공개 URL)
  중 하나는 있어야 한다(`<테이블>_location_check`).
- **프로젝트마다 철회되지 않은 계약 하나**: 서명 전에 철회된 계약(`CANCELLED`)은 기록으로 남고 그 프로젝트는 다시 모집할 수
  있어서, 한 프로젝트에 계약 행이 여럿일 수 있다. 그중 `CANCELLED`가 아닌 것은 하나뿐이다(부분 유니크 인덱스
  `Contract_projectId_live_key`, 위반은 다른 유니크 제약처럼 `P2002`). Prisma 5 스키마는 부분 인덱스를 표현하지 못하고 `migrate diff`도
  무시해서, 이 인덱스가 사라져도 drift로 잡히지 않는다. `test/db-constraints.test.ts`가 정의를 확인한다.
- **계약 철회 기록**: `Contract.cancelledAt`은 상태가 `CANCELLED`일 때만, 그때는 반드시 있고, `cancelledBy`(철회한 당사자의 역할)는
  `cancelledAt`과 함께만 있다(`Contract_cancelledAt_check`, `Contract_cancelledBy_check`). 철회한 사람을 사용자 id가 아니라
  역할로 두는 것은 당사자가 계약에 고정돼 있어서이고, FK가 없으면 철회가 사용자 행을 잠그지 않는다(아래 "동시성").

### `Message.sender`의 `onDelete: Restrict`

선택 관계의 Prisma 기본값은 `SetNull`이다. 그대로 두면 사용자 행이 지워질 때 그 사람의 `TEXT` 메시지가 발신자 없는 메시지,
즉 시스템 메시지처럼 보이는 행이 된다(위 "메시지" 불변식 위반). 사용자는 항상 소프트 삭제만 되므로 실제로 지워질 일은 없지만,
하드 삭제를 시도하면 DB가 막도록 `Restrict`를 명시했다.

### 외래 키의 삭제 동작

모든 필수 관계는 Prisma 기본값인 `ON DELETE RESTRICT`다. 선택 관계는 세 개다. `SettlementItem.settlementId`와
`EmailDelivery.notificationId`는 Prisma 기본값인 `SET NULL`이고, `Message.senderId`는 위 이유로 `RESTRICT`를 명시했다.
그래서 시드처럼 데이터를 지울 때는 자식부터 지워야 한다(`prisma/seed.js`의 `deleteMany` 순서).

### 지급 계좌번호 암호화

`PayoutAccount.accountNumber`는 애플리케이션이 저장 직전에 암호화한다(`src/lib/payoutAccountCrypto.ts`, [#28](https://github.com/jonghoon24/workbridge/issues/28)).
DB를 통째로 읽은 사람(백업, SQL 접근)도 키 없이는 계좌번호를 알 수 없게 하려는 것이다. 키는 DB 밖의 환경변수
`PAYOUT_ACCOUNT_ENCRYPTION_KEY`다(형식은 `workbridge-server/.env.example` 주석, 환경별 키와 교체는
[DEPLOYMENT.md](DEPLOYMENT.md#지급-계좌-암호화-키)).

- 저장 값의 접두어(`v1:`)가 키 버전이다. 키를 바꾼 뒤에도 옛 키로 쓴 행을 계속 읽기 위해서다.
- 추가 인증 데이터(AAD)는 그 행의 `userId`다. 다른 사용자 행에 암호문을 옮겨 붙이면 복호화가 실패한다(다른 사람의 정산금이
  그 계좌로 나가지 않는다). 잘못된 키, 변조된 값, 모르는 형식도 틀린 번호 대신 오류가 된다.
- 복호화는 응답의 마스킹과 지급 결정에서만 한다. 정산 행(`Settlement.accountNumberMasked`)에는 처음부터 마스킹한 값만 남는다.
- **암호화 전에 저장된 행**은 숫자 그대로이고 서버는 이것도 읽는다. 남은 평문 행은 백필 `npm run payout:encrypt-accounts`
  (원격은 `.github/workflows/payout-encrypt.yml`)가 암호화한다. SQL 마이그레이션으로는 키를 쓸 수 없어서 스크립트다. 행마다
  사용자 행을 잠그고 읽은 평문이 그대로일 때만 바꾸므로 서비스 중에 돌려도 되고 여러 번 돌려도 된다.
- 시드(`prisma/seed.js`)는 `prisma/payoutAccountCrypto.js`(같은 형식의 CommonJS 사본)로 암호화해 넣는다. 두 구현이 같은지는
  `test/payout-account-crypto.test.ts`가 시드 쪽 출력을 서버 코드로 복호화해 확인한다.

### 행 단위 보안

Supabase는 `public` 스키마를 Data API(PostgREST)로 공개한다. 그래서 RLS가 꺼진 테이블은 프로젝트 URL과 anon(publishable) 키만
있으면 누구나 읽고 쓸 수 있다. 앱은 Data API를 쓰지 않는다. 서버는 Prisma로 테이블 소유자 역할로 접속하고(소유자는 RLS를 우회한다),
Storage는 secret 키로만 다룬다. 그래서 **모든 테이블에 RLS를 켜고 정책은 두지 않는다**. anon·authenticated 역할은 아무 행도 보지
못하고, 앱 동작은 바뀌지 않는다(`20261111024733_enable_row_level_security`, `_prisma_migrations` 포함). 이 마이그레이션은
마이그레이션 역할이 소유하지 않은 테이블(확장이 만든 테이블 등)을 건너뛰고 `NOTICE`만 남긴다. 그런 테이블은 대시보드에서 따로 확인한다.

- RLS는 테이블마다 켜는 것이라 새 테이블은 그 테이블을 만드는 마이그레이션에서 따로 켜야 한다. 빠지면
  `test/db-constraints.test.ts`의 "row level security"가 실패하고, Supabase Security Advisor에 "RLS Disabled in Public"이 뜬다.
- 정책이 없으므로 `FORCE ROW LEVEL SECURITY`는 걸지 않는다. 걸면 소유자인 앱도 막힌다.

## 인덱스

인덱스는 실제로 도는 쿼리에 맞춰 달고, 어떤 인덱스가 있는지는 `schema.prisma`의 `@@index`가 원본이다. 유니크 제약은 자체
인덱스가 있으므로 따로 달지 않는다.

인덱스는 일반 `CREATE INDEX`로 만든다. 만드는 동안 그 테이블의 쓰기가 잠깐 막히지만 지금 행 수에서는 순간이다. 테이블이
커지면 `CREATE INDEX CONCURRENTLY`가 필요해진다.

## 소프트 삭제

`User`와 `Project`만 `deletedAt`으로 소프트 삭제하고, 모든 조회와 쓰기가 `deletedAt: null`로 거른다. 회원 탈퇴는 소프트 삭제에
더해 개인정보 컬럼을 비우거나 바꾼다(이름, 이메일 → `withdrawn:<id>`, 비밀번호, `googleId`, 프로필). 행은 거래 기록의 FK 대상이라
남긴다([domain/accounts.md](domain/accounts.md#회원-탈퇴)). 예외(정산·지급 계좌 등
돈, 가입 이메일 중복 확인)와 이유는 [domain/README.md](domain/README.md#소프트-삭제)에 있다. 포트폴리오와 경력은 하드 삭제한다.
`Message.deletedAt`은 소프트 삭제가 아니라 사용자의 "보낸 메시지 삭제"다. 행은 남고 API는 내용 없는 표시(tombstone)로 돌려주며,
첨부 파일은 `attachment.deleteObjects` 작업이 지운다.

## 시각

모든 `DateTime`은 Prisma 기본인 `timestamp(3)`(시간대 없음)에 UTC로 저장된다. 날짜 규칙의 KST 계산은
[domain/README.md](domain/README.md)의 "시간대"에 있다. raw SQL에 `Date`를 그대로 넘기면 `timestamptz`로 가서 세션 시간대
(로컬 PG는 Asia/Seoul)를 거쳐 9시간 어긋나므로, raw SQL의 시각은 `sqlTimestamp()`(`src/lib/sql.ts`)를 거친다.

## 동시성: 잠금과 조건부 쓰기

같은 행을 동시에 바꾸려는 요청은 두 가지 방법으로 차례를 정한다.

- **조건부 쓰기**: 상태 전이는 기대 상태를 조건에 넣은 `updateMany`다. 먼저 커밋한 요청만 행을 바꾼다. 진 요청은 바꾼
  행이 0개라서 409로 끝나거나 아무것도 하지 않는다.
- **행 잠금**: 여러 행을 한 번에 바꾸는 흐름은 raw SQL `SELECT … FOR UPDATE`로 행을 먼저 잠근다.

잠금을 둘 이상 잡는 트랜잭션은 교착할 수 있다. 두 트랜잭션이 같은 행들을 서로 다른 순서로 잡으면, 각자 하나를 쥔 채
상대가 쥔 것을 기다린다. 그래서 아래 순서를 지킨다. Postgres는 교착을 찾으면 한쪽을 `40P01`로 끊는다.

### 잠그는 행

| 잠그는 행 | 쓰는 곳 |
| --- | --- |
| `Contract` | 마일스톤 계획 교체. 마일스톤 승인(수동·자동): 같은 계약의 승인을 한 번에 하나로 만들어, 마지막 두 마일스톤이 동시에 승인돼도 계약 완료를 놓치지 않는다. |
| `Project` | 지원 수락: 다른 무엇보다 먼저, 트랜잭션의 첫 문장으로 잠근다. 같은 프로젝트의 수락이 한 번에 하나씩 돈다. 그러지 않으면 두 수락이 각자 자기 지원을 잠근 뒤, 상대의 지원을 거절하려고 서로 기다려 교착한다. |
| | 프로젝트 수정: 지원 수 확인과 예산·일정 변경을 한 잠금 안에서 한다. 지원 생성은 같은 행을 `FOR SHARE`로 잡으므로 둘이 차례로 돈다. |
| | 프로젝트 삭제: 계약이 있는지 확인과 소프트 삭제를 한 잠금 안에서 한다. 이미 삭제된 행은 잠그지 않고 404다. |
| | 다시 모집하기: 철회되지 않은 계약이 있는지 확인과 상태 변경을 한 잠금 안에서 한다. |
| `User` | 같은 사용자의 쓰기가 섞이면 안 되는 곳: 지급 계좌, 지급 결정, 주간 정산 배치, 포트폴리오·경력, 알림 설정, 지원 생성, 회원 탈퇴. 아래 "사용자 행 잠금" |
| `Project` → `Application` → `User` | 회원 탈퇴, 지원 생성. 아래 "회원 탈퇴와 지원 생성" |
| `Conversation` | 메시지와 시스템 메시지 게시 |
| `ConversationParticipant` | 미확인 메시지 다이제스트. 읽음 처리는 잠금 없이 조건부 쓰기다. |

### 사용자 행 잠금

`lockUserRow`(`src/lib/locks.ts`)는 사용자 행을 `FOR UPDATE`로 잠근다. 이 잠금 하나가 같은 사용자의 쓰기들의 차례를 정한다.
이 잠금은 트랜잭션의 첫 문장이다. 잠금보다 앞에 읽기가 있으면 그 읽기와 잠금 사이에 다른 요청이 끼어든다. 예를 들어
포트폴리오 개수 한도는 DB 제약이 아니라서, 두 요청이 잠금 전에 동시에 개수를 세면 둘 다 한도 안이라고 보고 한도를 넘긴다.
예외는 회원 탈퇴와 지원 생성이다(아래).

사용자 요청에서는 `lockActiveUserRow`를 쓴다. 잠금을 기다리는 사이 사용자가 탈퇴했으면 401로 끝나서, 탈퇴한 계정에 데이터를
다시 쓰지 않는다. 정산 배치와 지급 결정은 `lockUserRow`를 그대로 쓴다. 삭제된 사용자의 정산도 처리해야 하기 때문이다(보류).

### 정산: `User` 다음 `Settlement`

지급 결정과 주간 정산 배치(`settleFreelancer`)는 모두 트랜잭션의 첫 문장으로 프리랜서의 사용자 행을 잠그고, 그다음 정산 행을
조건부 쓰기로 잡는다. 배치가 정산 행부터 잡으면 이렇게 교착한다([#79](https://github.com/jonghoon24/workbridge/issues/79)).

1. 배치가 정산 행을 한 번 `UPDATE`한다. 그 행의 최신 버전은 이제 배치 트랜잭션이 만든 것이다.
2. 지급 결정이 사용자 행을 잠그고 정산 행을 기다린다.
3. 배치가 같은 정산 행을 다시 `UPDATE`한다. FK 컬럼을 바꾸지 않는 `UPDATE`는 보통 FK 검사를 건너뛰지만, 자기 트랜잭션이
   만든 행 버전이면 건너뛰지 않는다. 그래서 `Settlement.freelancerId`가 가리키는 사용자 행에 `FOR KEY SHARE`를 요청하고,
   2의 지급 결정을 기다린다.

**같은 트랜잭션에서 한 행을 두 번 쓰면 그 FK가 가리키는 부모 행도 잠긴다.** 잠금 순서를 정할 때 이 부모 행을 넣는다.

### 회원 탈퇴와 지원 생성: `Project` → `Application` → `User`

회원 탈퇴는 ① 자기 프로젝트 ② 지원(자기 지원, 그리고 자기 프로젝트에 들어온 대기 지원) ③ 자기 사용자 행 순서로 잠근다
(`account.service.ts`). 각 단계 안에서는 id 순이다. 이것은 지원 수락이 잠그는 순서와 같다. 수락은 `Project`를 잠그고, 지원
행을 조건부로 고치고, 계약을 넣는다. 계약을 넣을 때 FK 검사가 당사자 `User` 행에 `FOR KEY SHARE`를 잡는다. 탈퇴가 사용자
행부터 잡으면, 수락은 지원 행을 쥔 채 사용자 행을 기다리고 탈퇴는 사용자 행을 쥔 채 그 지원 행을 기다린다.

탈퇴는 지연 스윕과는 여전히 교착할 수 있다. 스윕은 여러 프로젝트와 여러 프리랜서의 지원을 정해지지 않은 순서로 고치기
때문이다. 드물고 Postgres가 한쪽을 끊으므로, 탈퇴는 교착 오류(`40P01`·`P2034`)를 받으면 트랜잭션을 한 번 다시 돌린다.
비밀번호 확인은 트랜잭션 밖이라 다시 하지 않는다. 끊긴 쪽이 스윕이면 다음 실행이 따라잡는다(멱등).

지원 생성도 같은 순서다. 프로젝트 행을 `FOR SHARE`로 잡아 상태를 다시 보고, 같은 프로젝트에 낸 자기 지원 행이 있으면
잠근 뒤, 사용자 행을 잡는다. 다시 지원하면 기존 지원 행을 고치므로, 사용자 행부터 잡으면 그 지원 행을 쥔 채 사용자 행을
기다리는 탈퇴와 교착한다. 프로젝트의 공유 잠금은 지원을 수락·모집 마감과 차례로 돌게 한다. 수락과 마감은 프로젝트 행을
바꾸거나 `FOR UPDATE`로 잡기 때문이다. 그래서 수락이 커밋된 프로젝트에 대기 지원이 되살아나지 않는다. 지원끼리는 공유
잠금이라 서로 막지 않는다.

### 계약·마일스톤 이벤트와 대화방

계약과 마일스톤 이벤트의 잠금 순서는 `Contract` → `Milestone` → 이벤트의 다른 쓰기 → `Conversation`이다.

- 대화방 시스템 메시지(`postSystemMessage`, `src/services/messaging.service.ts`)는 언제나 이벤트 트랜잭션의 **마지막
  쓰기**다(`MILESTONE_APPROVED` 다음 `CONTRACT_COMPLETED`처럼). 그래서 `Conversation` 잠금이 가장 늦게 잡히고, 대화방을
  잠근 트랜잭션이 그 뒤에 계약·마일스톤·프로젝트를 잠그는 일이 없다. 대화방 잠금은 다른 잠금과 순환을 만들지 않는다.
- 예외로 결제 확인과 dev-complete는 `Payment`를 `Milestone`보다 먼저 쓴다.
- `ConversationParticipant`는 다른 잠금과 함께 잡지 않는다.

### 잠금 없이 직렬화하는 곳

**결제 승인은 잠금 대신 선점으로 직렬화한다.** 토스페이먼츠 호출을 트랜잭션 안에 두지 않기 위해서다. 승인 요청은 공급자를
부르기 전에 `Payment.confirmStartedAt`을 조건부로 써서 그 결제를 선점한다. 쓰지 못한 요청은 409다. 선점에는 만료 시간이
있어서, 중간에 죽은 요청이 그 주문을 영원히 막지 않는다. 만료 시간과 공급자 타임아웃의 관계는
`src/services/payments.service.ts` 주석에 있다.

**계약 서명은 `FOR UPDATE` 없이 직렬화된다.** `UPDATE`가 잡는 행 잠금 때문에 두 당사자의 동시 서명이 차례로 커밋된다.
나중 서명자가 두 플래그가 모두 켜진 것을 보고 계약을 `ACTIVE`로 만든다(`recordSignature`,
`src/services/contracts.service.ts` 주석).

**서명 전 철회도 계약 행의 조건부 쓰기 하나로 직렬화된다**(`cancelContract`, `src/services/contracts.service.ts`).
잠금 순서는 `Contract` → 상대방 `User`(알림 행의 FK가 `FOR KEY SHARE`를 잡는다) → `Conversation`이고, 프로젝트 행은
잡지 않는다. 철회 트랜잭션은 계약 행을 **정확히 한 번** 쓴다. 두 번 쓰면 위 "정산"의 이유로 당사자 `User` 행까지 일찍
잠기고, `Project` → `Application` → `User` 순서로 잠그는 회원 탈퇴와 순환할 수 있다. 철회한 당사자를 FK 없는 역할로
남기는 것도 같은 이유다. 서명이 철회를 기다렸다가 철회된 행을 쓰게 되면 서명은 409로 끝나고 롤백된다.

## 금액이 `Float`인 부채

`Project.budget`, `Application.expectedRate`, `Contract.amount`, `Milestone.amount`, `Payment.amount`, 정산 금액들,
`User.hourlyRate`가 모두 `Float`(double)이다. 확장 이전부터 있던 부채이고 마이그레이션하지 않는다. 컬럼 대신 쓰는 값을 막는다.

- 요청 본문의 금액은 원 단위 정수만 받는다(소수 금액 입력은 400). 수수료 계산은 basis point 정수 연산이다.
- 계약 금액은 지원의 `expectedRate`라 소수일 수 있다. 마일스톤 관련 계산(기본 마일스톤, 계획 합계, 서명 때의 계획 검사)은
  `wholeWon(contract.amount)`(`Math.round`, 0.5는 올림)를 쓴다.
- SQL에서 금액을 반올림할 때는 `ROUND(x::numeric)`이어야 한다. Postgres의 `round()`는 `float8`에서 0.5를 짝수 쪽으로 보내서
  (`2500000.5` → `2500000`) `Math.round`(`2500001`)와 1원 어긋나고, 그렇게 만든 마일스톤 계획은 합계가 맞지 않아 서명 때의
  계획 검사에서 거절된다. `numeric`의 `ROUND`는 양수의 0.5를 올린다.

## 마이그레이션과 백필 메모

마이그레이션 목록과 내용은 `prisma/migrations/`의 폴더 이름과 SQL(머리 주석 포함)이 원본이다. 아래는 확장 마이그레이션이 기존
데이터를 어떻게 채웠는지, 즉 지금 데이터를 해석할 때 알아야 할 것이다.

- **기본 마일스톤 백필**: 확장 전에 있던 계약마다 마일스톤 1개(`전체 작업`, 금액 `ROUND(amount::numeric)`, 기한 = 계약 `endDate`)를
  만들었다. 완료 계약이면 `APPROVED`(`MANUAL`), 결제가 완료됐으면 `FUNDED`, 나머지는 `PENDING`. 기존 결제는 그 마일스톤에
  연결했고, 미완료 결제의 금액은 마일스톤 금액으로 맞췄다. 완료 계약의 `completedAt`은 알 수 없어 `createdAt`으로 채웠다.
- **정산 원장은 확장 이후 승인분부터다.** 확장 전에 완료된 계약의 마일스톤에는 `SettlementItem`이 없다(화면의 예상 정산액은
  현재 요율로 계산해 보여준다).
- **대화방 백필**: 확장 전 계약마다 대화방과 참여자 둘을 계약의 `createdAt`으로 만들었다. 메시지(시스템 메시지 포함)는 백필하지 않았다.
- **0원 예산·단가**: 1원 이상 규칙 전에 0원으로 저장된 `Project.budget`과 `User.hourlyRate`는 백필하지 않았다. 그 값을
  수정할 때까지 0원으로 남아 있으므로, 이 컬럼에 CHECK를 걸거나 백필할 때는 먼저 그런 행을 처리한다.
- **알림 설정**: 기본값과 다른 설정만 행으로 남는다. 행이 없으면 기본값이다.
- **비공개 버킷 이전 전의 첨부**는 `storageKey` 없이 공개 URL만 가진 행이다. 옮기는 절차는 [DEPLOYMENT.md](DEPLOYMENT.md)의
  "첨부 파일은 저장소로 직접 올린다".
