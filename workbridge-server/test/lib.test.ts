import { describe, expect, it } from 'vitest';

import { AppError } from '../src/lib/errors';
import { getProfileCompletion, isProfileComplete } from '../src/lib/profileCompletion';
import { getProjectStatusForRecruitmentStart } from '../src/lib/projectLifecycle';
import {
  expandSkillSearchTerms,
  normalizeSkill,
  normalizeSkillList,
} from '../src/lib/skills';
import type { ProfileCompletionInput, ProfileScoreInput } from '../src/types/index';
import {
  compareFreelancers,
  compareProjects,
  freshnessPoints,
  matchSkills,
  roundScore,
  scoreFreelancer,
  scoreProject,
} from '../src/lib/recommendations';
import { isKstMonth, kstMonthIndex, kstMonthString, kstMonthToDate } from '../src/lib/time';
import { summarizeCareers } from '../src/services/careers.service';

/**
 * Pure unit tests for `src/lib/`. No database, no HTTP, no mocks — every case here is
 * deterministic, and `getProjectStatusForRecruitmentStart` is always given an explicit
 * `now` (except for the two tests that deliberately exercise the default parameter with
 * dates centuries away from any plausible clock).
 *
 * Oracle: `docs/BEHAVIOR.md` §4 (profile completeness), §7 (lazy lifecycle), §1 (error
 * envelope / `AppError`), and the `skills` normalization rules referenced by
 * `PATCH /api/users/me` and `GET /api/projects`.
 */

// ---------------------------------------------------------------------------
// Local fixture builders. Kept in this file rather than in test/helpers so no other
// unit depends on them. `ProfileCompletionInput` requires all seven fields, so these
// spell out a complete profile and let each test blank exactly one thing out.
// ---------------------------------------------------------------------------

type Profile = ProfileCompletionInput;
type Overrides = Partial<Record<keyof Profile, unknown>>;

/** A CLIENT profile that satisfies §4. Freelancer-only fields are left empty on purpose. */
function clientProfile(overrides: Overrides = {}): Profile {
  return {
    role: 'CLIENT',
    companyName: 'Codeit',
    businessField: 'Education',
    skills: [],
    activityCategory: null,
    experienceYears: null,
    hourlyRate: null,
    ...overrides,
  } as Profile;
}

/** A FREELANCER profile that satisfies §4. Client-only fields are left empty on purpose. */
function freelancerProfile(overrides: Overrides = {}): Profile {
  return {
    role: 'FREELANCER',
    companyName: null,
    businessField: null,
    skills: ['React'],
    activityCategory: '개발',
    experienceYears: 3,
    hourlyRate: 50000,
    ...overrides,
  } as Profile;
}

// ---------------------------------------------------------------------------
// skills.ts — normalizeSkill
// ---------------------------------------------------------------------------

describe('normalizeSkill', () => {
  it('maps PostgreSQL to SQL', () => {
    expect(normalizeSkill('PostgreSQL')).toBe('SQL');
  });

  it('maps MySQL to SQL', () => {
    expect(normalizeSkill('MySQL')).toBe('SQL');
  });

  it('maps AWS S3 to AWS', () => {
    expect(normalizeSkill('AWS S3')).toBe('AWS');
  });

  it('passes an unknown skill through unchanged', () => {
    expect(normalizeSkill('React')).toBe('React');
    expect(normalizeSkill('Node.js')).toBe('Node.js');
    expect(normalizeSkill('Figma')).toBe('Figma');
  });

  it('passes a canonical skill through unchanged', () => {
    expect(normalizeSkill('SQL')).toBe('SQL');
    expect(normalizeSkill('AWS')).toBe('AWS');
  });

  it('is case-sensitive: lowercase postgresql is NOT mapped', () => {
    // Documents current behavior. `SKILL_ALIASES` is keyed by exact display casing, so
    // a user who types "postgresql" or "mysql" is stored as a distinct skill and will
    // not match an "SQL" search.
    expect(normalizeSkill('postgresql')).toBe('postgresql');
    expect(normalizeSkill('mysql')).toBe('mysql');
    expect(normalizeSkill('aws s3')).toBe('aws s3');
    expect(normalizeSkill('POSTGRESQL')).toBe('POSTGRESQL');
  });

  it('does not trim on its own — trimming is normalizeSkillList’s job', () => {
    expect(normalizeSkill('  PostgreSQL  ')).toBe('  PostgreSQL  ');
  });

  it('returns the empty string for the empty string', () => {
    expect(normalizeSkill('')).toBe('');
  });

  // The lookup is a bare object literal, so inherited Object.prototype members are
  // truthy hits: `SKILL_ALIASES['constructor']` returns the Object constructor, not
  // undefined. Intended behavior is "unknown skills pass through unchanged", so this
  // asserts the intent and fails today. Undocumented in BEHAVIOR.md — see report.
  it.fails('passes a skill named like an Object.prototype member through unchanged [undocumented]', () => {
    expect(normalizeSkill('constructor')).toBe('constructor');
    expect(normalizeSkill('toString')).toBe('toString');
  });
});

// ---------------------------------------------------------------------------
// skills.ts — normalizeSkillList
// ---------------------------------------------------------------------------

describe('normalizeSkillList', () => {
  it('accepts an array and normalizes each entry', () => {
    expect(normalizeSkillList(['React', 'PostgreSQL', 'AWS S3'])).toEqual(['React', 'SQL', 'AWS']);
  });

  it('accepts a comma-separated string', () => {
    expect(normalizeSkillList('React,Node.js')).toEqual(['React', 'Node.js']);
  });

  it('trims surrounding whitespace in both input forms', () => {
    expect(normalizeSkillList('  React ,  PostgreSQL  ')).toEqual(['React', 'SQL']);
    expect(normalizeSkillList([' React ', '\tMySQL\n'])).toEqual(['React', 'SQL']);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(normalizeSkillList(['React', '', '   '])).toEqual(['React']);
    expect(normalizeSkillList('React,,Node.js,')).toEqual(['React', 'Node.js']);
    expect(normalizeSkillList(',,,')).toEqual([]);
  });

  it('de-duplicates AFTER normalization, so PostgreSQL + MySQL collapse to one SQL', () => {
    expect(normalizeSkillList(['PostgreSQL', 'MySQL'])).toEqual(['SQL']);
    expect(normalizeSkillList('PostgreSQL,MySQL,SQL')).toEqual(['SQL']);
    expect(normalizeSkillList(['AWS S3', 'AWS'])).toEqual(['AWS']);
  });

  it('de-duplicates identical entries', () => {
    expect(normalizeSkillList(['React', 'React'])).toEqual(['React']);
  });

  it('preserves insertion order, keeping the first occurrence', () => {
    expect(normalizeSkillList(['Node.js', 'React', 'SQL'])).toEqual(['Node.js', 'React', 'SQL']);
    expect(normalizeSkillList(['MySQL', 'React', 'PostgreSQL'])).toEqual(['SQL', 'React']);
    expect(normalizeSkillList('Figma, React, Figma, Node.js')).toEqual(['Figma', 'React', 'Node.js']);
  });

  it('returns [] for undefined, null and the empty string', () => {
    expect(normalizeSkillList(undefined)).toEqual([]);
    expect(normalizeSkillList(null)).toEqual([]);
    expect(normalizeSkillList('')).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(normalizeSkillList([])).toEqual([]);
  });

  it('returns [] rather than ["0"] for falsy scalars', () => {
    // `String(value || '')` collapses every falsy input to '' before splitting.
    expect(normalizeSkillList(0)).toEqual([]);
    expect(normalizeSkillList(false)).toEqual([]);
  });

  it('does not mutate the array it is given', () => {
    const input = ['PostgreSQL', 'MySQL'];
    normalizeSkillList(input);
    expect(input).toEqual(['PostgreSQL', 'MySQL']);
  });

  it('throws on a non-string array element (unspecified in BEHAVIOR.md — see report)', () => {
    // Documenting current behavior on an input the spec does not cover: `skill.trim()`
    // assumes strings, so a JSON body like `{ "skills": [1] }` throws a TypeError.
    // Not asserted as *desirable* — §8 says malformed values should be 400 — but the
    // guard belongs to the controller, which is another unit's surface.
    expect(() => normalizeSkillList([1, 2])).toThrow(TypeError);
  });

  // Same Object.prototype leak as `normalizeSkill`, with a worse consequence: the
  // returned array is typed `string[]` but contains a function, which then reaches
  // Prisma as a `String[]` column value.
  it.fails('returns only strings for a skill named like an Object.prototype member [undocumented]', () => {
    expect(normalizeSkillList(['constructor'])).toEqual(['constructor']);
    expect(normalizeSkillList('valueOf').every((s) => typeof s === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skills.ts — expandSkillSearchTerms
// ---------------------------------------------------------------------------

describe('expandSkillSearchTerms', () => {
  it('expands a canonical skill to itself plus every alias mapping to it', () => {
    const terms = expandSkillSearchTerms('SQL');

    expect(terms).toContain('SQL');
    expect(terms).toContain('PostgreSQL');
    expect(terms).toContain('MySQL');
    expect(terms).toHaveLength(3);
  });

  it('puts the canonical skill first, then its aliases', () => {
    expect(expandSkillSearchTerms('SQL')).toEqual(['SQL', 'PostgreSQL', 'MySQL']);
    expect(expandSkillSearchTerms('AWS')).toEqual(['AWS', 'AWS S3']);
  });

  it('expands an alias by normalizing it to its canonical skill first', () => {
    expect(expandSkillSearchTerms('PostgreSQL')).toEqual(['SQL', 'PostgreSQL', 'MySQL']);
    expect(expandSkillSearchTerms('MySQL')).toEqual(['SQL', 'PostgreSQL', 'MySQL']);
    expect(expandSkillSearchTerms('AWS S3')).toEqual(['AWS', 'AWS S3']);
  });

  it('leaves a skill with no aliases as a single term', () => {
    expect(expandSkillSearchTerms('React')).toEqual(['React']);
  });

  it('de-duplicates across inputs that expand to the same family', () => {
    expect(expandSkillSearchTerms(['PostgreSQL', 'MySQL', 'SQL'])).toEqual(['SQL', 'PostgreSQL', 'MySQL']);
  });

  it('expands several families at once, in input order', () => {
    expect(expandSkillSearchTerms(['SQL', 'React', 'AWS S3'])).toEqual([
      'SQL', 'PostgreSQL', 'MySQL', 'React', 'AWS', 'AWS S3',
    ]);
  });

  it('accepts a comma-separated string', () => {
    expect(expandSkillSearchTerms('MySQL, React')).toEqual(['SQL', 'PostgreSQL', 'MySQL', 'React']);
  });

  it('returns [] for empty input', () => {
    expect(expandSkillSearchTerms([])).toEqual([]);
    expect(expandSkillSearchTerms('')).toEqual([]);
    expect(expandSkillSearchTerms(undefined)).toEqual([]);
    expect(expandSkillSearchTerms(null)).toEqual([]);
  });

  it('is case-sensitive, so lowercase sql does not pull in the aliases', () => {
    expect(expandSkillSearchTerms('sql')).toEqual(['sql']);
  });
});

// ---------------------------------------------------------------------------
// profileCompletion.ts — isProfileComplete (BEHAVIOR.md §4)
// ---------------------------------------------------------------------------

describe('isProfileComplete', () => {
  it('returns false for null', () => {
    expect(isProfileComplete(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isProfileComplete(undefined as unknown as null)).toBe(false);
  });

  it('returns false for an unknown role', () => {
    expect(isProfileComplete(clientProfile({ role: 'ADMIN' }))).toBe(false);
    expect(isProfileComplete(freelancerProfile({ role: '' }))).toBe(false);
    expect(isProfileComplete(clientProfile({ role: null }))).toBe(false);
  });

  describe('CLIENT', () => {
    it('is complete with companyName and businessField', () => {
      expect(isProfileComplete(clientProfile())).toBe(true);
    });

    it('is complete even though every freelancer field is empty', () => {
      expect(isProfileComplete(clientProfile({
        skills: [], activityCategory: null, experienceYears: null, hourlyRate: null,
      }))).toBe(true);
    });

    it('is incomplete without companyName', () => {
      expect(isProfileComplete(clientProfile({ companyName: null }))).toBe(false);
      expect(isProfileComplete(clientProfile({ companyName: '' }))).toBe(false);
    });

    it('is incomplete without businessField', () => {
      expect(isProfileComplete(clientProfile({ businessField: null }))).toBe(false);
      expect(isProfileComplete(clientProfile({ businessField: '' }))).toBe(false);
    });

    it('is incomplete when either field is whitespace-only', () => {
      expect(isProfileComplete(clientProfile({ companyName: '   ' }))).toBe(false);
      expect(isProfileComplete(clientProfile({ businessField: '\t\n ' }))).toBe(false);
    });

    it('accepts values that merely contain whitespace', () => {
      expect(isProfileComplete(clientProfile({ companyName: ' Codeit ', businessField: ' IT ' }))).toBe(true);
    });
  });

  describe('FREELANCER', () => {
    it('is complete with skills, activityCategory, experienceYears and hourlyRate', () => {
      expect(isProfileComplete(freelancerProfile())).toBe(true);
    });

    it('is complete even though every client field is empty', () => {
      expect(isProfileComplete(freelancerProfile({ companyName: null, businessField: null }))).toBe(true);
    });

    it('is incomplete with an empty skills array', () => {
      expect(isProfileComplete(freelancerProfile({ skills: [] }))).toBe(false);
    });

    it('is incomplete when skills is not an array', () => {
      expect(isProfileComplete(freelancerProfile({ skills: null }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ skills: 'React' }))).toBe(false);
    });

    it('is incomplete without activityCategory', () => {
      expect(isProfileComplete(freelancerProfile({ activityCategory: null }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ activityCategory: '' }))).toBe(false);
    });

    it('is incomplete when activityCategory is whitespace-only', () => {
      expect(isProfileComplete(freelancerProfile({ activityCategory: '  ' }))).toBe(false);
    });

    it('accepts experienceYears of 0', () => {
      expect(isProfileComplete(freelancerProfile({ experienceYears: 0 }))).toBe(true);
    });

    it('rejects a negative experienceYears', () => {
      expect(isProfileComplete(freelancerProfile({ experienceYears: -1 }))).toBe(false);
    });

    it('rejects a non-integer experienceYears', () => {
      expect(isProfileComplete(freelancerProfile({ experienceYears: 1.5 }))).toBe(false);
    });

    it('rejects a missing experienceYears', () => {
      expect(isProfileComplete(freelancerProfile({ experienceYears: null }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: undefined }))).toBe(false);
    });

    it('rejects a non-numeric experienceYears without throwing', () => {
      // Numeric-looking strings must not sneak through: `Number.isInteger` does not coerce.
      expect(isProfileComplete(freelancerProfile({ experienceYears: '3' }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: 'abc' }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: NaN }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: Infinity }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: {} }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ experienceYears: true }))).toBe(false);
    });

    it('accepts a fractional hourlyRate above 0', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: 0.5 }))).toBe(true);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: 1 }))).toBe(true);
    });

    it('rejects an hourlyRate of 0', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: 0 }))).toBe(false);
    });

    it('rejects a negative hourlyRate', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: -100 }))).toBe(false);
    });

    it('rejects a non-finite hourlyRate', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: Infinity }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: -Infinity }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: NaN }))).toBe(false);
    });

    it('rejects a missing hourlyRate', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: null }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: undefined }))).toBe(false);
    });

    it('rejects a non-numeric hourlyRate without throwing', () => {
      expect(isProfileComplete(freelancerProfile({ hourlyRate: '50000' }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: 'abc' }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: {} }))).toBe(false);
      expect(isProfileComplete(freelancerProfile({ hourlyRate: true }))).toBe(false);
    });

    it('returns a boolean, not a truthy string, for every branch', () => {
      // The implementation wraps the `&&` chain in Boolean(); without it the falsy
      // `activityCategory?.trim()` would leak '' out of a function typed `boolean`.
      expect(isProfileComplete(freelancerProfile({ activityCategory: '' }))).toStrictEqual(false);
      expect(isProfileComplete(clientProfile({ companyName: '' }))).toStrictEqual(false);
    });
  });
});

// ---------------------------------------------------------------------------
// projectLifecycle.ts — getProjectStatusForRecruitmentStart (BEHAVIOR.md §7)
// ---------------------------------------------------------------------------

describe('getProjectStatusForRecruitmentStart', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');

  it('returns UPCOMING for a future Date', () => {
    expect(getProjectStatusForRecruitmentStart(new Date('2026-08-01T00:00:00.000Z'), now)).toBe('UPCOMING');
  });

  it('returns OPEN for a past Date', () => {
    expect(getProjectStatusForRecruitmentStart(new Date('2026-06-01T00:00:00.000Z'), now)).toBe('OPEN');
  });

  it('returns UPCOMING for a future date string', () => {
    expect(getProjectStatusForRecruitmentStart('2026-08-01T00:00:00.000Z', now)).toBe('UPCOMING');
    expect(getProjectStatusForRecruitmentStart('2026-08-01', now)).toBe('UPCOMING');
  });

  it('returns OPEN for a past date string', () => {
    expect(getProjectStatusForRecruitmentStart('2026-06-01T00:00:00.000Z', now)).toBe('OPEN');
  });

  it('returns OPEN for null and undefined', () => {
    expect(getProjectStatusForRecruitmentStart(null, now)).toBe('OPEN');
    expect(getProjectStatusForRecruitmentStart(undefined, now)).toBe('OPEN');
  });

  it('returns OPEN for the empty string', () => {
    expect(getProjectStatusForRecruitmentStart('', now)).toBe('OPEN');
  });

  it('returns OPEN at the exact boundary — the comparison is strictly greater than', () => {
    expect(getProjectStatusForRecruitmentStart(new Date(now), now)).toBe('OPEN');
    expect(getProjectStatusForRecruitmentStart(now.toISOString(), now)).toBe('OPEN');
  });

  it('flips to UPCOMING one millisecond past the boundary', () => {
    expect(getProjectStatusForRecruitmentStart(new Date(now.getTime() + 1), now)).toBe('UPCOMING');
    expect(getProjectStatusForRecruitmentStart(new Date(now.getTime() - 1), now)).toBe('OPEN');
  });

  it('returns OPEN for an unparseable date (unspecified in BEHAVIOR.md — see report)', () => {
    // Documenting current behavior: `new Date('nope') > now` is false because every
    // comparison with NaN is false, so garbage silently reads as "already recruiting".
    // §8 wants malformed values rejected with 400, but that guard belongs to the controller.
    expect(getProjectStatusForRecruitmentStart('not-a-date', now)).toBe('OPEN');
  });

  it('defaults now to the current time — a far-future date is UPCOMING', () => {
    expect(getProjectStatusForRecruitmentStart(new Date('3000-01-01T00:00:00.000Z'))).toBe('UPCOMING');
  });

  it('defaults now to the current time — a far-past date is OPEN', () => {
    expect(getProjectStatusForRecruitmentStart(new Date('2000-01-01T00:00:00.000Z'))).toBe('OPEN');
  });

  it('does not mutate the Date it is given', () => {
    const start = new Date('2026-08-01T00:00:00.000Z');
    const before = start.getTime();
    getProjectStatusForRecruitmentStart(start, now);
    expect(start.getTime()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// errors.ts — AppError (BEHAVIOR.md §1)
// ---------------------------------------------------------------------------

describe('AppError', () => {
  it('carries the message and statusCode it was constructed with', () => {
    const err = new AppError('프로필을 먼저 완성해주세요', 403);

    expect(err.message).toBe('프로필을 먼저 완성해주세요');
    expect(err.statusCode).toBe(403);
  });

  it('names itself AppError so errorHandler can tell it apart', () => {
    expect(new AppError('nope', 400).name).toBe('AppError');
  });

  it('is an instanceof Error and of AppError', () => {
    const err = new AppError('nope', 400);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('has a stack trace pointing at the construction site', () => {
    const err = new AppError('nope', 500);

    expect(typeof err.stack).toBe('string');
    expect(err.stack?.length).toBeGreaterThan(0);
    expect(err.stack).toContain('lib.test.ts');
  });

  it('preserves any status code, including 5xx', () => {
    expect(new AppError('upstream died', 502).statusCode).toBe(502);
    expect(new AppError('boom', 500).statusCode).toBe(500);
    expect(new AppError('conflict', 409).statusCode).toBe(409);
  });

  it('is throwable and catchable as an AppError', () => {
    expect(() => {
      throw new AppError('Not authorized', 403);
    }).toThrow(AppError);

    try {
      throw new AppError('Not authorized', 403);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).message).toBe('Not authorized');
    }
  });

  it('keeps an empty message empty rather than substituting a default', () => {
    expect(new AppError('', 400).message).toBe('');
  });
});

// ---------------------------------------------------------------------------
// time.ts — calendar months (BEHAVIOR.md PF2)
// ---------------------------------------------------------------------------

describe('KST months', () => {
  it('stores a month as its first instant in KST: 2025-03 → 2025-02-28T15:00:00.000Z [PF2]', () => {
    expect(kstMonthToDate('2025-03').toISOString()).toBe('2025-02-28T15:00:00.000Z');
    expect(kstMonthToDate('2025-01').toISOString()).toBe('2024-12-31T15:00:00.000Z');
  });

  it('round-trips through kstMonthString [PF2]', () => {
    for (const month of ['2020-01', '2024-02', '2025-12']) {
      expect(kstMonthString(kstMonthToDate(month))).toBe(month);
    }
  });

  it('reads the KST month of an instant, not the UTC one [PF2]', () => {
    // 2025-03-31T15:00Z is 2025-04-01 00:00 KST.
    expect(kstMonthString(new Date('2025-03-31T15:00:00.000Z'))).toBe('2025-04');
    expect(kstMonthString(new Date('2025-03-31T14:59:59.999Z'))).toBe('2025-03');
  });

  it('accepts only YYYY-MM with months 01–12 [PF2]', () => {
    for (const ok of ['2025-01', '2025-12', '1999-09']) expect(isKstMonth(ok)).toBe(true);
    for (const bad of ['2025-00', '2025-13', '2025-1', '25-01', '2025-03-01', '2025/03', '', ' 2025-03']) {
      expect(isKstMonth(bad)).toBe(false);
    }
    expect(() => kstMonthToDate('2025-13')).toThrow(RangeError);
  });

  it('indexes months so that differences count months [PF6]', () => {
    expect(kstMonthIndex('2022-02') - kstMonthIndex('2020-01') + 1).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// careers.service.ts — summarizeCareers (BEHAVIOR.md PF6)
// ---------------------------------------------------------------------------

describe('summarizeCareers', () => {
  const range = (start: string, end: string | null) => ({
    startDate: kstMonthToDate(start),
    endDate: end === null ? null : kstMonthToDate(end),
  });
  const NOW = new Date('2026-10-21T03:00:00.000Z'); // 2026-10 KST

  it('merges overlapping ranges: 2020-01…2021-06 + 2021-03…2022-02 = 26 months, 2 years 2 months [PF6]', () => {
    expect(summarizeCareers([range('2020-01', '2021-06'), range('2021-03', '2022-02')], NOW))
      .toEqual({ totalMonths: 26, years: 2, months: 2 });
  });

  it('counts a single month as 1 and nothing as 0 [PF6]', () => {
    expect(summarizeCareers([range('2024-05', '2024-05')], NOW)).toEqual({ totalMonths: 1, years: 0, months: 1 });
    expect(summarizeCareers([], NOW)).toEqual({ totalMonths: 0, years: 0, months: 0 });
  });

  it('merges adjacent ranges and keeps gaps out [PF6]', () => {
    expect(summarizeCareers([range('2020-01', '2020-06'), range('2020-07', '2020-12')], NOW).totalMonths).toBe(12);
    expect(summarizeCareers([range('2020-01', '2020-06'), range('2020-08', '2020-12')], NOW).totalMonths).toBe(11);
  });

  it('counts a current position through the KST month of now, and a nested range once [PF6]', () => {
    expect(summarizeCareers([range('2026-01', null)], NOW).totalMonths).toBe(10);
    expect(summarizeCareers([range('2026-01', null), range('2026-03', '2026-04')], NOW).totalMonths).toBe(10);
    expect(summarizeCareers([range('2026-08', null), range('2026-09', null)], NOW).totalMonths).toBe(3);
  });

  it('does not depend on the input order [PF6]', () => {
    const ranges = [range('2023-01', '2023-03'), range('2020-01', '2020-02'), range('2022-12', '2023-01')];
    expect(summarizeCareers(ranges, NOW)).toEqual(summarizeCareers([...ranges].reverse(), NOW));
    expect(summarizeCareers(ranges, NOW).totalMonths).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// profileCompletion.ts — getProfileCompletion (BEHAVIOR.md PF21)
// ---------------------------------------------------------------------------

describe('getProfileCompletion', () => {
  const NONE = { portfolioItems: 0, careers: 0, hasPayoutAccount: false };
  const ALL = { portfolioItems: 3, careers: 1, hasPayoutAccount: true };
  const scoreInput = (profile: Profile, extra: Partial<ProfileScoreInput> = {}): ProfileScoreInput => ({
    bio: null,
    profileImage: null,
    website: null,
    ...profile,
    ...extra,
  });

  it('weights each role\'s checklist to 100 [PF21]', () => {
    const freelancer = getProfileCompletion(scoreInput(freelancerProfile(), { bio: 'b', profileImage: 'p' }), ALL);
    const client = getProfileCompletion(scoreInput(clientProfile(), { bio: 'b', profileImage: 'p', website: 'w' }), NONE);

    expect(freelancer.percent).toBe(100);
    expect(freelancer.items.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(client.percent).toBe(100);
    expect(client.items.map((item) => item.key)).toEqual(['companyName', 'businessField', 'bio', 'profileImage', 'website']);
  });

  it('keeps isComplete equal to isProfileComplete, independent of percent [PF21]', () => {
    const gateOnly = getProfileCompletion(scoreInput(freelancerProfile()), NONE);
    const allButRate = getProfileCompletion(scoreInput(freelancerProfile({ hourlyRate: null }), { bio: 'b', profileImage: 'p' }), ALL);

    expect(gateOnly).toMatchObject({ isComplete: true, percent: 45 });
    expect(allButRate).toMatchObject({ isComplete: false, percent: 90 });
  });

  it('marks portfolioThree only at three items [PF21]', () => {
    const two = getProfileCompletion(scoreInput(freelancerProfile()), { ...NONE, portfolioItems: 2 });
    const done = Object.fromEntries(two.items.map((item) => [item.key, item.done]));

    expect(done).toMatchObject({ portfolio: true, portfolioThree: false });
  });
});

// ---------------------------------------------------------------------------
// recommendations.ts — scoring (BEHAVIOR.md RC1, RC2, RC4, RC7)
// ---------------------------------------------------------------------------

describe('recommendation scoring', () => {
  it('rounds to two decimals with Math.round(x × 100) / 100 [RC1]', () => {
    expect(roundScore(69.16666)).toBe(69.17);
    expect(roundScore(66.95652)).toBe(66.96);
    expect(roundScore(12.345)).toBe(12.35);
    expect(roundScore(50)).toBe(50);
  });

  it('matches normalized skills exactly, in the project\'s order [RC2]', () => {
    expect(matchSkills(['SQL', 'React', 'AWS'], ['react', 'PostgreSQL', 'AWS S3'])).toEqual(['SQL', 'AWS']);
    expect(matchSkills(['MySQL', 'PostgreSQL'], ['SQL'])).toEqual(['SQL']);
    expect(matchSkills([], ['React'])).toEqual([]);
  });

  it('scores the RC4 worked example at 69.17 [RC4]', () => {
    const result = scoreFreelancer(
      { requiredSkills: ['React', 'Node.js', 'SQL'], category: '웹 개발' },
      {
        skills: ['React', 'PostgreSQL', 'Java'],
        activityCategory: '웹 개발',
        experienceYears: 4,
        portfolioSkills: [['React']],
        avgRating: 4.5,
      },
    );

    expect(result).toEqual({ score: 69.17, matchedSkills: ['React', 'SQL'] });
  });

  it('gives 9 rating points with no reviews, caps experience at 10 years, compares category exactly [RC4]', () => {
    const base = { skills: [], portfolioSkills: [], experienceYears: 25, avgRating: null };
    const project = { requiredSkills: [], category: '웹 개발' };

    expect(scoreFreelancer(project, { ...base, activityCategory: '웹 개발' }).score).toBe(15 + 9 + 10);
    expect(scoreFreelancer(project, { ...base, activityCategory: '웹 개발 ' }).score).toBe(9 + 10);
  });

  it('scores the RC7 worked example at 66.96 [RC7]', () => {
    const now = new Date('2026-10-21T00:00:00.000Z');
    const result = scoreProject(
      {
        requiredSkills: ['React', 'Node.js'],
        category: '웹 개발',
        createdAt: new Date(now.getTime() - 14 * 86_400_000),
        deadline: new Date(now.getTime() + 10 * 86_400_000),
      },
      { skills: ['React', 'TypeScript'], activityCategory: '웹 개발' },
      now,
    );

    expect(result).toEqual({ score: 66.96, matchedSkills: ['React'] });
  });

  it('decays freshness linearly from 10 at 7 days to 0 at 30 days [RC7]', () => {
    const now = new Date('2026-10-21T00:00:00.000Z');
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

    expect(freshnessPoints(ago(0), now)).toBe(10);
    expect(freshnessPoints(ago(7), now)).toBe(10);
    expect(freshnessPoints(ago(18.5), now)).toBe(5);
    expect(freshnessPoints(ago(30), now)).toBe(0);
    expect(freshnessPoints(ago(45), now)).toBe(0);
  });

  it('gives deadline room only at 3 × 24 h or more [RC7]', () => {
    const now = new Date('2026-10-21T00:00:00.000Z');
    const project = (ms: number) => ({ requiredSkills: [], category: 'x', createdAt: new Date(now.getTime() - 40 * 86_400_000), deadline: new Date(now.getTime() + ms) });
    const caller = { skills: ['React'], activityCategory: 'y' };

    expect(scoreProject(project(3 * 86_400_000), caller, now).score).toBe(10);
    expect(scoreProject(project(3 * 86_400_000 - 1), caller, now).score).toBe(0);
  });

  it('sorts deterministically: score, then reviewCount / deadline, then id [RC4] [RC7]', () => {
    const freelancers = [
      { id: 'b', score: 50, reviewCount: 0 },
      { id: 'a', score: 50, reviewCount: 0 },
      { id: 'c', score: 50, reviewCount: 2 },
      { id: 'd', score: 60, reviewCount: 0 },
    ];
    expect([...freelancers].sort(compareFreelancers).map((f) => f.id)).toEqual(['d', 'c', 'a', 'b']);

    const later = new Date('2026-11-02T00:00:00Z');
    const sooner = new Date('2026-11-01T00:00:00Z');
    const projects = [
      { id: 'b', score: 70, deadline: sooner },
      { id: 'a', score: 70, deadline: sooner },
      { id: 'c', score: 70, deadline: later },
      { id: 'd', score: 71, deadline: later },
    ];
    expect([...projects].sort(compareProjects).map((p) => p.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});
