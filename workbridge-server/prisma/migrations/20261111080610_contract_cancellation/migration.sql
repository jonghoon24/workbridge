-- Either party may cancel a contract before both have signed (#113). The cancelled row stays as the
-- record, so a project can now have several contracts — but at most one that is not CANCELLED.
--
-- The `CANCELLED` enum value is added by the previous migration: Postgres refuses a new enum value in
-- the transaction that adds it (55P04), and the index predicate and CHECKs below use it.
--
-- Safe for the code that runs before this release: the new columns are nullable, nothing it writes is
-- CANCELLED, and its lookups by `projectId` are plain WHERE clauses that the new indexes still serve.

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" "Role";

-- One live contract per project. Prisma's schema cannot express a partial index (and `migrate diff`
-- ignores it, so it is never dropped as drift); it lives only here (docs/DATABASE.md "관계와 불변식").
-- Created before the old unique index is dropped. A violation is still P2002 to Prisma.
CREATE UNIQUE INDEX "Contract_projectId_live_key" ON "Contract"("projectId") WHERE "status" <> 'CANCELLED';

-- DropIndex
DROP INDEX "Contract_projectId_key";

-- CreateIndex: the foreign key itself, cancelled contracts included.
CREATE INDEX "Contract_projectId_idx" ON "Contract"("projectId");

-- `cancelledAt` is set exactly when the contract is CANCELLED, and `cancelledBy` exactly with it.
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_cancelledAt_check"
  CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_cancelledBy_check"
  CHECK (("cancelledAt" IS NULL) = ("cancelledBy" IS NULL));
