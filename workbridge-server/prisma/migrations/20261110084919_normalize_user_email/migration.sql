-- Stores every User.email in the form signup, login and the Google callback now compare
-- (`normalizeEmail`: surrounding spaces removed, lowercased). Data only; no schema change.
--
-- Soft-deleted rows are included: `email` is unique across all rows, deleted ones too.
--
-- Two rows that become equal (e.g. `Victim@x.com` and `victim@x.com`) cannot both be kept, and
-- choosing which account wins is a product decision, not a migration's. So the migration stops
-- before changing anything and says why. The message carries only the count, not the addresses,
-- because migration output lands in CI logs. To list them:
--
--   SELECT lower(btrim(email, E' \t\n\r\f')) AS normalized, array_agg(id ORDER BY "createdAt") AS ids
--   FROM "User" GROUP BY 1 HAVING count(*) > 1;
DO $$
DECLARE
  duplicates integer;
BEGIN
  SELECT count(*) INTO duplicates
  FROM (SELECT 1 FROM "User" GROUP BY lower(btrim(email, E' \t\n\r\f')) HAVING count(*) > 1) AS d;

  IF duplicates > 0 THEN
    RAISE EXCEPTION 'Cannot normalize User.email: % address(es) differ from another account only by case or surrounding spaces. Merge or rename those accounts first (see the query in this migration).', duplicates;
  END IF;
END $$;

UPDATE "User"
SET email = lower(btrim(email, E' \t\n\r\f'))
WHERE email <> lower(btrim(email, E' \t\n\r\f'));
