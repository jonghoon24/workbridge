-- String[] columns must not hold NULL elements (#54). Prisma's `String[]` assumes every element is
-- a string; a row with a NULL element makes every query that reads it throw (P2032), so one bad
-- project would take down `GET /api/projects`. The API never writes one (zod checks every element);
-- this guards operator SQL, backfills and the seed. Prisma's schema cannot express a CHECK, so it
-- lives only here (docs/DATABASE.md "관계와 불변식").
--
-- `array_position(arr, NULL)` compares with IS NOT DISTINCT FROM, so it finds a NULL element and
-- returns NULL when there is none.

-- 1. Drop any NULL elements already stored, so the constraints can be added.
UPDATE "User" SET "skills" = array_remove("skills", NULL)
  WHERE array_position("skills", NULL) IS NOT NULL;
UPDATE "Project" SET "requiredSkills" = array_remove("requiredSkills", NULL)
  WHERE array_position("requiredSkills", NULL) IS NOT NULL;
UPDATE "MilestoneSubmission" SET "links" = array_remove("links", NULL)
  WHERE array_position("links", NULL) IS NOT NULL;
UPDATE "PortfolioItem" SET "skills" = array_remove("skills", NULL)
  WHERE array_position("skills", NULL) IS NOT NULL;
UPDATE "Review" SET "tags" = array_remove("tags", NULL)
  WHERE array_position("tags", NULL) IS NOT NULL;

-- 2. Reject them from now on.
ALTER TABLE "User" ADD CONSTRAINT "User_skills_no_null"
  CHECK (array_position("skills", NULL) IS NULL);
ALTER TABLE "Project" ADD CONSTRAINT "Project_requiredSkills_no_null"
  CHECK (array_position("requiredSkills", NULL) IS NULL);
ALTER TABLE "MilestoneSubmission" ADD CONSTRAINT "MilestoneSubmission_links_no_null"
  CHECK (array_position("links", NULL) IS NULL);
ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_skills_no_null"
  CHECK (array_position("skills", NULL) IS NULL);
ALTER TABLE "Review" ADD CONSTRAINT "Review_tags_no_null"
  CHECK (array_position("tags", NULL) IS NULL);
