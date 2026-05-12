const SKILL_ALIASES = {
  PostgreSQL: 'SQL',
  MySQL: 'SQL',
  'AWS S3': 'AWS',
};

export function normalizeSkill(skill) {
  return SKILL_ALIASES[skill] || skill;
}

export function normalizeSkillList(value) {
  const skills = Array.isArray(value)
    ? value
    : String(value || '').split(',');

  const normalized = skills
    .map((skill) => normalizeSkill(skill.trim()))
    .filter(Boolean);

  return [...new Set(normalized)];
}

export function expandSkillSearchTerms(value) {
  const canonicalSkills = normalizeSkillList(value);
  const aliasesByCanonicalSkill = Object.entries(SKILL_ALIASES).reduce((acc, [alias, canonical]) => {
    acc[canonical] = [...(acc[canonical] || []), alias];
    return acc;
  }, {});

  return [
    ...new Set(canonicalSkills.flatMap((skill) => [skill, ...(aliasesByCanonicalSkill[skill] || [])])),
  ];
}
