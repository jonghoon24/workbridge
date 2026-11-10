import type { Role } from '@prisma/client';
import { z } from '../lib/zod';

import { normalizeSkillList } from '../lib/skills';

/**
 * `PATCH /api/users/me`. The route takes `multipart/form-data` (the client
 * sends that, for `profileImage`) or JSON, so numbers may arrive as strings. Validation runs after
 * the upload middleware, which fills `req.body`. A failure is a 400
 * `<field>: <message>`; the client maps the messages to Korean
 * (`workbridge-client/src/lib/errorMessages.js`), so keep the two in sync.
 *
 * Only fields present in the body change. Fields of the other role are **not validated** and are
 * stripped, so they are silently ignored rather than rejected (a deliberate choice): a CLIENT and a FREELANCER have
 * separate schemas, picked by the caller's role ({@link profileUpdateBodyByRole}).
 */

export const PROFILE_MESSAGES = {
  experienceYears: 'Experience years must be a non-negative integer',
  hourlyRate: 'Hourly rate must be a positive whole number of won',
  hourlyRateMax: 'Hourly rate must be at most 100,000,000 won',
  skills: 'Skills must be strings',
} as const;

/** `experienceYears` is an `Int` column; a larger value would be a database error (a 500). */
const MAX_INT32 = 2_147_483_647;

/** An hourly rate above 100 million won is a typo, not a price; it would also skew rate analysis. */
export const MAX_HOURLY_RATE = 100_000_000;

/** A text column that may be cleared: a string (an empty one is stored as is) or JSON `null`. */
function optionalText(label: string) {
  return z.string({ invalid_type_error: `${label} must be a string` }).nullable().optional();
}

/** In multipart a number is a string; convert only a well-formed one and leave the rest to fail. */
function numericString(pattern: RegExp) {
  return (value: unknown) => (typeof value === 'string' && pattern.test(value.trim()) ? Number(value.trim()) : value);
}

/**
 * An integer `>= 0`, as a JSON number or a decimal string (`'7'`). `'abc'`, `'1.5'`, `-1`, an
 * empty multipart field and `null` are 400s — the row is left unchanged, never set to `null`.
 */
const experienceYears = z.preprocess(
  numericString(/^\d+$/),
  z
    .number({ invalid_type_error: PROFILE_MESSAGES.experienceYears })
    .int(PROFILE_MESSAGES.experienceYears)
    .min(0, PROFILE_MESSAGES.experienceYears)
    .max(MAX_INT32, PROFILE_MESSAGES.experienceYears),
);

/**
 * Whole won, 1 to {@link MAX_HOURLY_RATE} (money rule: amounts are integers; a rate of 0 won is
 * not a price), as a JSON number or a digit string (`'45000'`). `0`, `'45000.5'`, `-1`, `'abc'`,
 * `''` and `null` are 400s. The column is still a `Float` (known debt), so this is the only guard.
 */
const hourlyRate = z.preprocess(
  numericString(/^\d+$/),
  z
    .number({ invalid_type_error: PROFILE_MESSAGES.hourlyRate })
    .int(PROFILE_MESSAGES.hourlyRate)
    .min(1, PROFILE_MESSAGES.hourlyRate)
    .max(MAX_HOURLY_RATE, PROFILE_MESSAGES.hourlyRateMax),
);

/**
 * One comma-separated string (multipart, or JSON), an array of strings (repeated multipart
 * fields, or a JSON array — kept verbatim, so a skill may contain a comma), or `null` (cleared).
 * Normalized through `SKILL_ALIASES` and de-duplicated. A non-string element is a 400.
 */
const skills = z
  .union([z.string(), z.array(z.string()), z.null()], {
    errorMap: () => ({ message: PROFILE_MESSAGES.skills }),
  })
  .transform((value) => normalizeSkillList(value ?? []));

/** Fields both roles may set. */
const commonFields = {
  name: z
    .string({ invalid_type_error: 'Name must be a string' })
    .trim()
    .min(1, 'Name is required')
    .optional(),
  bio: optionalText('Bio'),
};

export const clientProfileUpdateBody = z.object({
  ...commonFields,
  companyName: optionalText('Company name'),
  businessField: optionalText('Business field'),
  website: optionalText('Website'),
});

export const freelancerProfileUpdateBody = z.object({
  ...commonFields,
  skills: skills.optional(),
  activityCategory: optionalText('Activity category'),
  experienceYears: experienceYears.optional(),
  hourlyRate: hourlyRate.optional(),
  portfolioUrl: optionalText('Portfolio URL'),
});

/** The body schema for the caller's role; the other role's fields are stripped. */
export const profileUpdateBodyByRole = {
  CLIENT: clientProfileUpdateBody,
  FREELANCER: freelancerProfileUpdateBody,
} as const satisfies Record<Role, z.ZodTypeAny>;

export type ProfileUpdateInput =
  | z.infer<typeof clientProfileUpdateBody>
  | z.infer<typeof freelancerProfileUpdateBody>;
