---
paths:
  - "workbridge-server/prisma/**"
  - "docs/DATABASE.md"
---

# Prisma 스키마, 마이그레이션, 시드

- **적용된 마이그레이션은 고치지 않는다.** `prisma/migrations/` 아래 폴더를 수정하거나 지우지 않는다 —
  이미 preview와 production DB에서 돌았고, Prisma가 체크섬을 검사한다. PreToolUse 훅이 커밋된
  마이그레이션의 편집을 모두 막는다(아직 git에 없는 `--create-only` 폴더에는 백필 SQL을 넣을 수 있다).
  스키마를 바꾸려면: `schema.prisma` 수정 → `npx prisma migrate dev --name <name>` → `npm run db:generate`
  (`db-migration` 스킬). 잘못된 마이그레이션은 새 마이그레이션으로 고친다.
- `prisma migrate reset`, `db push --force-reset`/`--accept-data-loss`를 돌리거나 커맨드에
  `supabase.co`/`supabase.com` URL을 넣지 않는다 — `.claude/settings.json`에서 거부된다.
- 스키마를 고친 뒤에는 새 필드를 쓰기 전에 마이그레이션**과** `db:generate`를 돌린다.
  `npm run typecheck`가 생성된 클라이언트에 의존한다.
- `prisma/seed.js`는 트랜스파일 없이 `node`로 도는 순수 CommonJS JavaScript로 둔다. `tsconfig.json`은
  일부러 `prisma/`를 뺀다. 변환하지 않는다. 시드하는 모델이 바뀌면 함께 고친다(`docs/SEED_DATA.md`도).
- 소프트 삭제: `User`와 `Project`에 `deletedAt`이 있다. 모든 읽기와 쓰기가 `deletedAt: null`로 거른다
  (`findUnique`가 아니라 필터를 건 `findFirst`). 예외는 BEHAVIOR.md 규칙 5에 있다
  (가입의 이메일 중복 확인, 정산과 지급 계좌).
- 불변식: `Project.contract` 1:1, `Payment.milestoneId`와 `SettlementItem.milestoneId` 유니크,
  `Application`은 `(projectId, freelancerId)`마다 하나, `Review`는 `(contractId, reviewerId)`마다 하나.
  유니크 충돌 → 409(P2002는 트랜잭션 밖에서 catch).
- 금액 컬럼은 `Float`(의도된 부채 — 마이그레이션하지 않는다)이고, 계산은 `lib/money.ts`로 원 단위 정수로 한다.
- 모델이나 컬럼이 바뀔 때마다 `docs/DATABASE.md`를 고친다.
