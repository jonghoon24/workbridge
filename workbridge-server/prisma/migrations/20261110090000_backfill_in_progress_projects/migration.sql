-- Data only (#46): signing a contract now moves its project to IN_PROGRESS. Projects whose
-- contract started before that change are still CLOSED; move them to match.
UPDATE "Project"
SET "status" = 'IN_PROGRESS'
WHERE "status" = 'CLOSED'
  AND EXISTS (
    SELECT 1
    FROM "Contract"
    WHERE "Contract"."projectId" = "Project"."id"
      AND "Contract"."status" = 'ACTIVE'
  );
