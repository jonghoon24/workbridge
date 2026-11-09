const SKILL_ALIASES: Record<string, string> = {
  PostgreSQL: 'SQL',
  MySQL: 'SQL',
  'AWS S3': 'AWS',
};

export function normalizeSkill(skill: string): string {
  // Own keys only: `SKILL_ALIASES.constructor` is inherited from Object.prototype.
  return Object.hasOwn(SKILL_ALIASES, skill) ? SKILL_ALIASES[skill] : skill;
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
  // A Map, not an object literal, so a skill named `constructor` finds no aliases.
  const aliasesByCanonicalSkill = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
    aliasesByCanonicalSkill.set(canonical, [...(aliasesByCanonicalSkill.get(canonical) ?? []), alias]);
  }

  return [
    ...new Set(canonicalSkills.flatMap((skill) => [skill, ...(aliasesByCanonicalSkill.get(skill) ?? [])])),
  ];
}
