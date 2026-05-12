UPDATE "User"
SET "skills" = (
  SELECT ARRAY(
    SELECT normalized_skill
    FROM (
      SELECT normalized_skill, MIN(item_index) AS first_position
      FROM unnest("User"."skills") WITH ORDINALITY AS item(skill, item_index)
      CROSS JOIN LATERAL (
        VALUES (
          CASE item.skill
            WHEN 'PostgreSQL' THEN 'SQL'
            WHEN 'MySQL' THEN 'SQL'
            WHEN 'AWS S3' THEN 'AWS'
            ELSE item.skill
          END
        )
      ) AS normalized(normalized_skill)
      GROUP BY normalized_skill
      ORDER BY first_position
    ) AS deduped
  )
)
WHERE "skills" && ARRAY['PostgreSQL', 'MySQL', 'AWS S3'];

UPDATE "Project"
SET "requiredSkills" = (
  SELECT ARRAY(
    SELECT normalized_skill
    FROM (
      SELECT normalized_skill, MIN(item_index) AS first_position
      FROM unnest("Project"."requiredSkills") WITH ORDINALITY AS item(skill, item_index)
      CROSS JOIN LATERAL (
        VALUES (
          CASE item.skill
            WHEN 'PostgreSQL' THEN 'SQL'
            WHEN 'MySQL' THEN 'SQL'
            WHEN 'AWS S3' THEN 'AWS'
            ELSE item.skill
          END
        )
      ) AS normalized(normalized_skill)
      GROUP BY normalized_skill
      ORDER BY first_position
    ) AS deduped
  )
)
WHERE "requiredSkills" && ARRAY['PostgreSQL', 'MySQL', 'AWS S3'];
