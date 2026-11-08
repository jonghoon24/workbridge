---
paths:
  - "workbridge-server/prisma/**"
  - "docs/DATABASE.md"
---

# Prisma schema, migrations, seed

- **Applied migrations are immutable.** Never edit or delete a folder under
  `prisma/migrations/` — it has already run on the preview and production databases, and Prisma
  checks checksums. A PreToolUse hook blocks edits to every committed migration (a fresh,
  still-untracked `--create-only` folder may get its backfill SQL). To change the schema: edit
  `schema.prisma` → `npx prisma migrate dev --name <name>` → `npm run db:generate`
  (`db-migration` skill). Fix a bad migration with a new one.
- Never run `prisma migrate reset`, `db push --force-reset`/`--accept-data-loss`, or point a
  command at a `supabase.co`/`supabase.com` URL — denied in `.claude/settings.json`.
- After any schema edit run a migration **and** `db:generate` before using new fields;
  `npm run typecheck` depends on the generated client.
- `prisma/seed.js` stays plain CommonJS JavaScript, run by `node` untranspiled; `tsconfig.json`
  deliberately excludes `prisma/`. Don't convert it. Update it when a seeded model changes
  (and `docs/SEED_DATA.md`).
- Soft delete: `User` and `Project` have `deletedAt`. Every read and write filters
  `deletedAt: null` (use `findFirst` with the filter, not `findUnique`). Exceptions are documented
  in BEHAVIOR.md rule 5 (signup's duplicate-email check; settlements/payout accounts).
- Invariants: `Project.contract` 1:1; `Payment.milestoneId` and `SettlementItem.milestoneId`
  unique; `Application` unique per `(projectId, freelancerId)`; `Review` unique per
  `(contractId, reviewerId)`. Unique collisions → 409 (catch P2002 outside the transaction).
- Money columns are `Float` (intended debt — don't migrate); compute in integer won via `lib/money.ts`.
- Update `docs/DATABASE.md` with every model/column change.
