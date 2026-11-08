---
name: db-migration
description: Change the WorkBridge database schema safely — edit schema.prisma, create a new Prisma migration against the local DB, regenerate the client, update tests, seed and docs/DATABASE.md. Use for any new model, column, index, enum value or backfill. Never edits an applied migration.
argument-hint: <short_snake_case_name> — <what changes>
---

# Database migration

Everything runs inside `workbridge-server/` against the **local** Postgres in `.env`
(`localhost`). Preview and production databases are never touched from here: CI applies
migrations to both on merge to `main` (see step 8).

## 0. Ground rules

- **Applied migrations are immutable.** Never edit, rename or delete a folder in
  `prisma/migrations/` — it already ran on preview/production and Prisma checks its checksum.
  A PreToolUse hook blocks edits to any migration that is in git. A mistake is fixed by a *new*
  migration.
- Never `prisma migrate reset`, `db push --force-reset`, `--accept-data-loss` (denied in
  `.claude/settings.json`). If `migrate dev` says it needs a reset because of drift, stop and ask.
- Money columns stay `Float` (intended debt). `User`/`Project` deletion stays soft (`deletedAt`).

## 1. Edit `prisma/schema.prisma`

- Follow the neighbours: `String @id @default(uuid())`, `createdAt DateTime @default(now())`,
  explicit `onDelete` on every relation (see "외래 키의 삭제 동작" in `docs/DATABASE.md`),
  `@@unique` for invariants the code relies on (409 on collision), `@@index` for list filters.
- Adding a required column to a table with rows needs a default or a backfill (step 3).

```bash
npx prisma validate
npx prisma format
```

## 2. Create and apply the migration locally

```bash
npx prisma migrate dev --name <short_snake_case_name>
```

This writes `prisma/migrations/<timestamp>_<name>/migration.sql`, applies it to the local DB and
regenerates the client. Read the generated SQL: check for dropped columns/tables (data loss),
enum changes, and `NOT NULL` without a default.

## 3. Backfill (if needed)

Put the backfill in the same new migration: `npx prisma migrate dev --create-only --name <name>`
writes the SQL without applying it; append the `UPDATE …` statements, then `npx prisma migrate dev`
to apply. The hook allows edits only while the migration folder is untracked in git; once it is
committed it is treated as applied and frozen.
Round money as numeric (`ROUND(x::numeric)`), not float — see "마이그레이션과 백필 메모".

## 4. Regenerate and typecheck

```bash
npm run db:generate
npm run typecheck
```

## 5. Tests

- New table → add it to `TABLES` in `test/helpers/db.ts` (children before parents), or
  `resetDb()` leaves rows behind between tests.
- New model used in tests → add a `make<Model>()` factory in `test/helpers/factories.ts`.
- Migrate the test DB and run the suite:

```bash
bash scripts/test-db.sh   # runs prisma migrate deploy on workbridge_test
npm test
```

## 6. Seed

If the model or column appears in the demo data, update `prisma/seed.js` — **plain CommonJS**,
run by `node` untranspiled (it mirrors `lib/time.ts`/`lib/money.ts` by hand; keep them in sync),
and `docs/SEED_DATA.md`. Check: `npm run db:seed`.

## 7. Docs

`docs/DATABASE.md` (Korean): the model in its section under "모델", enums/state flows,
"관계와 불변식", soft-delete or locking notes if relevant, and a row in the
"마이그레이션과 백필 메모" table (`| \`<timestamp>_<name>\` | <내용> |`) plus any backfill note.

## 8. Deployment

- Commit `schema.prisma` and the whole new migration folder together with the code that uses it.
- On merge to `main`, the CI migration job runs `prisma migrate deploy` against the **preview and
  production** databases (separate Supabase projects). Don't run it by hand and never paste their
  connection strings into a command.
- The migration must be safe while the previous code version is still serving (Vercel switches
  over after the migration): add columns nullable or with defaults; drop old columns in a later
  release.

## 9. Report

Migration name, SQL summary (tables/columns/indexes), backfill, files touched, typecheck and
test results.
