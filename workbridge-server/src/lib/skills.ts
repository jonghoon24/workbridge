const SKILL_ALIASES: Record<string, string> = {
  PostgreSQL: 'SQL',
  MySQL: 'SQL',
  'AWS S3': 'AWS',
};

export function normalizeSkill(skill: string): string {
  return SKILL_ALIASES[skill] || skill;
}

export function normalizeSkillList(value: unknown): string[] {
  const skills: string[] = Array.isArray(value)
    ? value
    : String(value || '').split(',');

  const normalized = skills
    .map((skill) => normalizeSkill(skill.trim()))
    .filter(Boolean);

  return [...new Set(normalized)];
}

export function expandSkillSearchTerms(value: unknown): string[] {
  const canonicalSkills = normalizeSkillList(value);
  const aliasesByCanonicalSkill = Object.entries(SKILL_ALIASES)
    .reduce<Record<string, string[]>>((acc, [alias, canonical]) => {
      acc[canonical] = [...(acc[canonical] || []), alias];
      return acc;
    }, {});

  return [
    ...new Set(canonicalSkills.flatMap((skill) => [skill, ...(aliasesByCanonicalSkill[skill] || [])])),
  ];
}
