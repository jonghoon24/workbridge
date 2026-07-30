import { describe, expect, it } from 'vitest';

import { AppError } from '../src/lib/errors';
import { isProfileComplete } from '../src/lib/profileCompletion';
import { getProjectStatusForRecruitmentStart } from '../src/lib/projectLifecycle';
import {
  expandSkillSearchTerms,
  normalizeSkill,
  normalizeSkillList,
} from '../src/lib/skills';
import type { ProfileCompletionInput } from '../src/types/index';

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
