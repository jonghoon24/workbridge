UPDATE "Project"
SET "status" = 'CLOSED'
WHERE "status" = 'IN_PROGRESS'
  AND EXISTS (
    SELECT 1
    FROM "Contract"
    WHERE "Contract"."projectId" = "Project"."id"
  );
