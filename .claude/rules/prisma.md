---
paths:
  - "workbridge-server/prisma/**"
  - "docs/DATABASE.md"
---

# Prisma 스키마, 마이그레이션, 시드

- 스키마 변경은 `schema.prisma` 수정 → `npx prisma migrate dev --name <name>` 순서로 한다. 절차는 `db-migration` 스킬.
- 새 테이블은 만드는 마이그레이션에서 `ENABLE ROW LEVEL SECURITY`를 켠다(정책 없이, `FORCE`도 없이).
  Supabase가 `public`을 Data API로 공개하기 때문이다(`docs/DATABASE.md` "행 단위 보안").
- 새 `String[]` 컬럼에는 마이그레이션 SQL에 `"<Table>_<column>_no_null"` CHECK(`array_position("<column>", NULL) IS NULL`)를
  함께 건다. Prisma는 원소가 모두 문자열이라고 가정해서, `NULL` 원소가 든 행 하나가 그 행을 읽는 쿼리 전체를
  `P2032`로 실패시킨다. Prisma 스키마로는 표현되지 않으니 필드 옆에 주석을 단다(기존 `String[]` 필드 참고).
- 금액 컬럼의 `Float`는 알고 있는 부채다. 다른 변경에 섞어 `Int`로 마이그레이션하지 않는다. 계산은 `lib/money.ts`로 원 단위 정수로 한다.
- `prisma/seed.js`는 트랜스파일 없이 `node`로 도는 순수 CommonJS JavaScript로 둔다(`tsconfig.json`이 `prisma/`를 뺀다).
  TypeScript로 바꾸지 않는다. 시드하는 모델이 바뀌면 함께 고친다(`docs/SEED_DATA.md`도).
- 불변식, 스키마가 표현하지 못하는 제약(CHECK 등), 잠금, FK 삭제 동작이 바뀌면 `docs/DATABASE.md`를 고친다.
