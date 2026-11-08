---
name: db-migration
description: WorkBridge 데이터베이스 스키마를 안전하게 바꾼다(schema change, migration) — schema.prisma 수정, 로컬 DB에 새 Prisma 마이그레이션 생성, 클라이언트 재생성, 테스트·시드·docs/DATABASE.md 갱신. 새 모델, 컬럼, 인덱스, enum 값, 백필(backfill)에 쓴다. 적용된 마이그레이션은 절대 고치지 않는다.
argument-hint: <short_snake_case_name> — <바뀌는 것>
---

# 데이터베이스 마이그레이션

모든 작업은 `workbridge-server/` 안에서 `.env`의 **로컬** Postgres(`localhost`)를 대상으로 한다.
preview와 production DB는 여기서 절대 건드리지 않는다: `main`에 머지될 때 CI(`migrate.yml`)가 두 DB에
적용한다(8단계 참고).

## 0. 기본 규칙

- **적용된 마이그레이션은 고치지 않는다.** `prisma/migrations/`의 폴더를 수정하거나 이름을 바꾸거나
  지우지 않는다 — 이미 preview/production에서 돌았고 Prisma가 체크섬을 검사한다.
  PreToolUse 훅이 git에 있는 마이그레이션의 편집을 막는다. 실수는 *새* 마이그레이션으로 고친다.
- `prisma migrate reset`, `db push --force-reset`, `--accept-data-loss`는 쓰지 않는다
  (`.claude/settings.json`에서 거부). `migrate dev`가 drift 때문에 reset이 필요하다고 하면 멈추고 묻는다.
- 금액 컬럼은 `Float`로 둔다(의도된 부채). `User`/`Project` 삭제는 소프트 삭제(`deletedAt`)로 둔다.

## 1. `prisma/schema.prisma` 수정

- 이웃 모델을 따른다: `String @id @default(uuid())`, `createdAt DateTime @default(now())`,
  모든 관계에 `onDelete`를 명시(`docs/DATABASE.md`의 "외래 키의 삭제 동작" 참고), 코드가 기대는
  불변식에는 `@@unique`(충돌하면 409), 목록 필터에는 `@@index`.
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

## 3. 백필 (필요하면)

백필은 같은 새 마이그레이션에 넣는다: `npx prisma migrate dev --create-only --name <name>`이 적용하지
않고 SQL만 쓴다. 거기에 `UPDATE …` 문을 붙인 뒤 `npx prisma migrate dev`로 적용한다. 훅은
마이그레이션 폴더가 git에 추적되지 않는 동안만 편집을 허용한다. 커밋하면 적용된 것으로 보고 고정된다.
금액은 float이 아니라 numeric으로 반올림한다(`ROUND(x::numeric)`) — "마이그레이션과 백필 메모" 참고.

## 4. 재생성과 타입 체크

```bash
npm run db:generate
npm run typecheck
```

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

모델이나 컬럼이 데모 데이터에 나오면 `prisma/seed.js`를 고친다 — 트랜스파일 없이 `node`로 도는
**순수 CommonJS**다(`lib/time.ts`/`lib/money.ts`를 손으로 따라 해 두었으니 함께 맞춘다).
`docs/SEED_DATA.md`도 고친다. 확인: `npm run db:seed`.

## 7. 문서

`docs/DATABASE.md`(한국어): "모델" 아래 해당 절의 모델, enum/상태 흐름, "관계와 불변식",
관련 있으면 소프트 삭제나 잠금 메모, 그리고 "마이그레이션과 백필 메모" 표의 한 행
(`| \`<timestamp>_<name>\` | <내용> |`)과 백필 메모.

## 8. 배포

- `schema.prisma`와 새 마이그레이션 폴더 전체를 그것을 쓰는 코드와 함께 커밋한다.
- `main`에 머지되면 `.github/workflows/migrate.yml`이 **preview와 production** DB(서로 다른 Supabase
  프로젝트)에 차례로 `prisma migrate deploy`를 돌린다. 손으로 돌리지 않고, 그 접속 문자열을 커맨드에
  넣지 않는다.
- 이전 버전 코드가 아직 서비스하는 동안에도 안전한 마이그레이션이어야 한다(Vercel은 마이그레이션
  뒤에 전환된다): 컬럼은 nullable이나 기본값을 두고 추가하고, 옛 컬럼은 다음 릴리스에서 지운다.

## 9. 보고

마이그레이션 이름, SQL 요약(테이블/컬럼/인덱스), 백필, 건드린 파일, 타입 체크와 테스트 결과.
