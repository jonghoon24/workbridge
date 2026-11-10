-- CreateEnum
CREATE TYPE "AttachmentUploadScope" AS ENUM ('MESSAGE', 'MILESTONE_SUBMISSION');

-- AlterTable
ALTER TABLE "MessageAttachment" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "url" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MilestoneAttachment" ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "url" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AttachmentUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "AttachmentUploadScope" NOT NULL,
    "targetId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentUpload_storageKey_key" ON "AttachmentUpload"("storageKey");

-- CreateIndex
CREATE INDEX "AttachmentUpload_userId_scope_targetId_idx" ON "AttachmentUpload"("userId", "scope", "targetId");

-- CreateIndex
CREATE INDEX "AttachmentUpload_expiresAt_idx" ON "AttachmentUpload"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_storageKey_key" ON "MessageAttachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneAttachment_storageKey_key" ON "MilestoneAttachment"("storageKey");

-- AddForeignKey
ALTER TABLE "AttachmentUpload" ADD CONSTRAINT "AttachmentUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An attachment is either in the private bucket (storageKey) or a legacy public URL (url).
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_location_check" CHECK ("storageKey" IS NOT NULL OR "url" IS NOT NULL);
ALTER TABLE "MilestoneAttachment" ADD CONSTRAINT "MilestoneAttachment_location_check" CHECK ("storageKey" IS NOT NULL OR "url" IS NOT NULL);
