---
name: db-migration
description: WorkBridge 데이터베이스 스키마를 안전하게 바꾼다(schema change, migration) — schema.prisma 수정, 로컬 DB에 새 Prisma 마이그레이션 생성, 클라이언트 재생성, 테스트·시드·문서 갱신. 새 모델, 컬럼, 인덱스, enum 값, 백필(backfill)에 쓴다. 적용된 마이그레이션은 절대 고치지 않는다.
argument-hint: <short_snake_case_name> — <바뀌는 것>
---

# 데이터베이스 마이그레이션

모든 작업은 `workbridge-server/` 안에서 `.env`의 **로컬** Postgres(`localhost`)를 대상으로 한다.
preview와 production DB에는 `main`에 머지될 때 CI(`migrate.yml`)가 적용한다(8단계 참고).
이미 커밋된 마이그레이션은 고치지 않는다. 실수는 *새* 마이그레이션으로 고친다.
`migrate dev`가 drift 때문에 reset이 필요하다고 하면 멈추고 사용자에게 묻는다.

## 1. `prisma/schema.prisma` 수정

- 이웃 모델을 따른다: `String @id @default(uuid())`, `createdAt DateTime @default(now())`, 코드가 기대는
  불변식에는 `@@unique`(충돌하면 409), 목록 필터에는 `@@index`.
- 관계의 삭제 동작은 Prisma 기본값을 따른다. 필수 관계는 `RESTRICT`, 선택 관계는 `SET NULL`이다. 기본값과 다르게 할
  때만 `onDelete`를 적고 이유를 필드 옆 주석에 단다(예: `Message.sender`). 그때는 `docs/DATABASE.md` "외래 키의 삭제
  동작"도 고친다.
- 행이 있는 테이블에 필수 컬럼을 추가하려면 기본값이나 백필(3단계)이 필요하다.

```bash
npx prisma validate
npx prisma format
```

## 2. 로컬에서 마이그레이션 생성과 적용

```bash
npx prisma migrate dev --name <short_snake_case_name>
```

이 커맨드가 `prisma/migrations/<timestamp>_<name>/migration.sql`을 쓰고, 로컬 DB에 적용하고,
클라이언트를 다시 생성한다. 생성된 SQL을 읽는다: 지워지는 컬럼/테이블(데이터 손실), enum 변경,
기본값 없는 `NOT NULL`을 확인한다.

**새 테이블이나 새 `String[]` 컬럼이면 SQL을 손으로 더한다.** `npx prisma migrate dev --create-only --name <name>`으로
SQL만 만들고, 끝에 붙인 뒤 `npx prisma migrate dev`로 적용한다(규칙과 이유: `.claude/rules/prisma.md`).

```sql
ALTER TABLE "<Model>" ENABLE ROW LEVEL SECURITY;                 -- 새 테이블마다. 정책은 만들지 않는다
ALTER TABLE "<Model>" ADD CONSTRAINT "<Model>_<column>_no_null"  -- 새 String[] 컬럼마다
  CHECK (array_position("<column>", NULL) IS NULL);
```

RLS를 빠뜨리면 `test/db-constraints.test.ts`가 실패한다. `String[]` CHECK는 그 파일의 `targets`에 행을 추가해야 검사된다.

## 3. 백필 (필요하면)

백필은 같은 새 마이그레이션에 넣는다: `npx prisma migrate dev --create-only --name <name>`이 적용하지
않고 SQL만 쓴다. 거기에 `UPDATE …` 문을 붙인 뒤 `npx prisma migrate dev`로 적용한다. 훅은
마이그레이션 폴더가 git에 추적되지 않는 동안만 편집을 허용한다. 커밋하면 적용된 것으로 보고 고정된다.
금액은 float이 아니라 numeric으로 반올림한다(`ROUND(x::numeric)`, 이유는 `docs/DATABASE.md` "금액이 `Float`인 부채").

## 4. 타입 체크

```bash
npm run typecheck
```

`migrate dev`가 클라이언트를 이미 다시 만들었다. 다른 브랜치의 마이그레이션을 `migrate deploy`로만 받은
worktree라면 먼저 `npm run db:generate`를 돌린다.

## 5. 테스트

- 새 테이블 → `test/helpers/db.ts`의 `TABLES`에 추가한다(자식을 부모보다 먼저). 빠뜨리면 `resetDb()`가
  테스트 사이에 행을 남긴다.
- 테스트에서 쓰는 새 모델 → `test/helpers/factories.ts`에 `make<Model>()` 팩토리를 추가한다.
- 테스트 DB를 마이그레이션하고 스위트를 돌린다:

```bash
bash scripts/test-db.sh   # workbridge_test에 prisma migrate deploy를 돌린다
npm test
```

## 6. 시드

모델이나 컬럼이 시드 데이터에 나오면 `prisma/seed.js`를 고친다. 이 파일은 `lib/time.ts`와 `lib/money.ts`의 계산을
손으로 옮겨 두었으므로, 그 계산이 바뀌었으면 함께 맞춘다.
`docs/SEED_DATA.md`도 고친다. 확인: `npm run db:seed`.

## 7. 문서

`docs/DATABASE.md`(한국어)는 바뀐 것이 있을 때만 고친다: "관계와 불변식", "외래 키의 삭제 동작", 스키마가 표현하지
못하는 제약(CHECK 등), 소프트 삭제나 잠금 메모, 백필이 있으면 "마이그레이션과 백필 메모". 모델과 필드 목록은
`schema.prisma`가 원본이라 옮겨 적지 않는다.

새 컬럼이 API 응답에 나가면 `src/openapi/responses/<domain>.ts`의 응답 스키마에도 추가하고 `openapi.json`을 다시
만든다(빠뜨리면 그 응답을 받는 테스트가 strict 검사에서 실패한다).
변경이 제품 결정을 담고 있으면(새 상태와 전이 등) 그 결정과 이유를 `docs/domain/`의 해당 문서에 적는다.

## 8. 배포

- `schema.prisma`와 새 마이그레이션 폴더 전체를 그것을 쓰는 코드와 함께 커밋한다.
- `main`에 머지되면 `.github/workflows/migrate.yml`이 **preview와 production** DB(서로 다른 Supabase
  프로젝트)에 차례로 `prisma migrate deploy`를 돌린다.
- 마이그레이션은 이전 코드와 새 코드 어느 쪽이 떠 있어도 안전해야 한다. 같은 `main` 푸시에서 Vercel 배포와
  `migrate.yml`이 따로 돌고, 둘의 순서를 맞추는 장치가 없다. 그래서 새 코드가 마이그레이션 전의 DB를 잠깐 상대할 수
  있다. 컬럼은 nullable이나 기본값을 두고 추가하고, 옛 컬럼은 다음 릴리스에서 지운다.
- 스키마를 바꾸는 PR의 서버 프리뷰도 머지 전까지는 마이그레이션되지 않은 프리뷰 DB를 상대한다.

## 9. 보고

마이그레이션 이름, SQL 요약(테이블/컬럼/인덱스), 백필, 건드린 파일, 타입 체크와 테스트 결과.
