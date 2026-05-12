UPDATE "Contract" AS contract
SET "amount" = application."expectedRate"
FROM "Application" AS application
WHERE contract."applicationId" = application."id"
  AND contract."amount" <> application."expectedRate"
  AND NOT EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    WHERE payment."contractId" = contract."id"
      AND payment."status" IN ('COMPLETED', 'REFUNDED')
  );

UPDATE "Payment" AS payment
SET "amount" = contract."amount"
FROM "Contract" AS contract
WHERE payment."contractId" = contract."id"
  AND payment."status" IN ('PENDING', 'FAILED')
  AND payment."amount" <> contract."amount";
