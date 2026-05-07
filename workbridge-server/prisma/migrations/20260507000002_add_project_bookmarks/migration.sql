CREATE TABLE "ProjectBookmark" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectBookmark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectBookmark_projectId_userId_key" ON "ProjectBookmark"("projectId", "userId");
CREATE INDEX "ProjectBookmark_userId_createdAt_idx" ON "ProjectBookmark"("userId", "createdAt");

ALTER TABLE "ProjectBookmark" ADD CONSTRAINT "ProjectBookmark_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectBookmark" ADD CONSTRAINT "ProjectBookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
