-- Phase 1: milestones and settlements (BEHAVIOR.md "Milestones", "Settlements", "Payout account").
-- Generated with `prisma migrate diff`, then hand-edited: `Payment.milestoneId` is added nullable,
-- every existing contract gets its default milestone (backfill below), and only then does the
-- column become NOT NULL and unique. `@default(uuid())` and `@updatedAt` are client-side defaults,
-- so the backfill writes `id`, `createdAt` and `updatedAt` itself.

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PENDING', 'FUNDED', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "SubmissionDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'PAID', 'FAILED', 'ON_HOLD');

-- DropIndex
DROP INDEX "Payment_contractId_key";

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "milestoneId" TEXT;

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PENDING',
    "fundedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "autoApproveAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvalType" "ApprovalType",
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneSubmission" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "links" TEXT[],
    "decision" "SubmissionDecision",
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "autoDecided" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneAttachment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "settlementId" TEXT,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "feeRateBps" INTEGER NOT NULL,
    "feeAmount" DOUBLE PRECISION NOT NULL,
    "feeVatAmount" DOUBLE PRECISION NOT NULL,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "scheduledPayoutAt" TIMESTAMP(3) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'SCHEDULED',
    "itemCount" INTEGER NOT NULL,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "feeAmount" DOUBLE PRECISION NOT NULL,
    "feeVatAmount" DOUBLE PRECISION NOT NULL,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "payoutAttempts" INTEGER NOT NULL DEFAULT 0,
    "bankName" TEXT,
    "accountNumberMasked" TEXT,
    "accountHolder" TEXT,
    "providerReference" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id")
);

-- Backfill 1: one default milestone per existing contract.
-- Amount is the contract amount in whole won (M7). `ROUND` on `numeric`, not on the float8
-- column: Postgres rounds float8 halves to even (2500000.5 -> 2500000) while `Math.round` rounds
-- them up, and a backfilled plan one won short would fail the signing check (CT7).
-- Status: a COMPLETED contract's milestone is APPROVED; a contract whose payment completed has a
-- FUNDED milestone; everything else is PENDING. Due date is the contract's end date.
-- Approved milestones get no SettlementItem: the settlement ledger starts with the expansion.
INSERT INTO "Milestone" (
    "id", "contractId", "sequence", "title", "amount", "dueDate", "status",
    "fundedAt", "approvedAt", "approvalType", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    c."id",
    1,
    '전체 작업',
    ROUND(c."amount"::numeric)::double precision,
    c."endDate",
    CASE
        WHEN c."status" = 'COMPLETED' THEN 'APPROVED'::"MilestoneStatus"
        WHEN p."status" = 'COMPLETED' THEN 'FUNDED'::"MilestoneStatus"
        ELSE 'PENDING'::"MilestoneStatus"
    END,
    CASE WHEN p."status" = 'COMPLETED' THEN p."createdAt" END,
    CASE WHEN c."status" = 'COMPLETED' THEN now() END,
    CASE WHEN c."status" = 'COMPLETED' THEN 'MANUAL'::"ApprovalType" END,
    now(),
    now()
FROM "Contract" c
LEFT JOIN "Payment" p ON p."contractId" = c."id";

-- Backfill 2: attach each payment (at most one per contract until now) to that milestone.
UPDATE "Payment" p
SET "milestoneId" = m."id"
FROM "Milestone" m
WHERE m."contractId" = p."contractId" AND m."sequence" = 1;

-- Backfill 3: unpaid payments take the whole-won milestone amount, so a fractional contract
-- amount no longer makes them unpayable.
UPDATE "Payment" p
SET "amount" = m."amount"
FROM "Milestone" m
WHERE m."id" = p."milestoneId" AND p."status" IN ('PENDING', 'FAILED');

-- Backfill 4: completion time of already-completed contracts is unknown; approximate it.
UPDATE "Contract" SET "completedAt" = "createdAt" WHERE "status" = 'COMPLETED';

ALTER TABLE "Payment" ALTER COLUMN "milestoneId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Milestone_status_autoApproveAt_idx" ON "Milestone"("status", "autoApproveAt");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_contractId_sequence_key" ON "Milestone"("contractId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneSubmission_milestoneId_round_key" ON "MilestoneSubmission"("milestoneId", "round");

-- CreateIndex
CREATE INDEX "MilestoneAttachment_submissionId_idx" ON "MilestoneAttachment"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementItem_milestoneId_key" ON "SettlementItem"("milestoneId");

-- CreateIndex
CREATE INDEX "SettlementItem_freelancerId_settlementId_idx" ON "SettlementItem"("freelancerId", "settlementId");

-- CreateIndex
CREATE INDEX "SettlementItem_settlementId_idx" ON "SettlementItem"("settlementId");

-- CreateIndex
CREATE INDEX "Settlement_status_scheduledPayoutAt_idx" ON "Settlement"("status", "scheduledPayoutAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_freelancerId_periodStart_key" ON "Settlement"("freelancerId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccount_userId_key" ON "PayoutAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_milestoneId_key" ON "Payment"("milestoneId");

-- CreateIndex
CREATE INDEX "Payment_contractId_idx" ON "Payment"("contractId");

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneSubmission" ADD CONSTRAINT "MilestoneSubmission_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneAttachment" ADD CONSTRAINT "MilestoneAttachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "MilestoneSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

