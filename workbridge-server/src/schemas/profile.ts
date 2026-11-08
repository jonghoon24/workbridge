import { z } from 'zod';

import { normalizeSkillList } from '../lib/skills';
import { isKstMonth, kstMonthString } from '../lib/time';
import { queryInt } from './common';

/**
 * Request bodies and queries of the portfolio, career and recommendation routes (BEHAVIOR.md
 * PF1, PF2, PF9–PF14, RC1). Messages are part of the spec — tests assert them exactly — so keep
 * them in sync with BEHAVIOR.md.
 */

/** PF1. */
export const PORTFOLIO_LIMITS = {
  items: 20,
  title: 100,
  description: 2000,
  url: 2000,
  role: 100,
  skills: 10,
  skill: 50,
} as const;

/** PF1. */
export const CAREER_LIMITS = {
  entries: 30,
  company: 100,
  position: 100,
  description: 2000,
} as const;

export const MONTH_MESSAGES = {
  format: 'Month must be a YYYY-MM month',
  future: 'Month cannot be in the future',
  order: 'End month must not be before start month',
  startRequired: 'Start month is required with an end month',
} as const;

// ---------------------------------------------------------------------------------------------
// Field building blocks
// ---------------------------------------------------------------------------------------------

/** A required text field: trimmed, 1–`max` characters. */
function requiredText(label: string, max: number) {
  return z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);
}

/**
 * Absent stays absent (`undefined`, so a PATCH leaves the column alone); `null` or `''` becomes
 * `null` (cleared).
 */
function emptyToNull(value: string | null | undefined): string | null | undefined {
  return value === undefined ? undefined : value || null;
}

/** An optional text field: trimmed, at most `max`; sent empty (or `null`) it is stored as `null`. */
function optionalText(message: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform(emptyToNull);
}

function isHttpUrl(value: string): boolean {
  if (value.length > PORTFOLIO_LIMITS.url) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const optionalUrl = z
  .string()
  .trim()
  .nullish()
  .transform(emptyToNull)
  .refine((value) => value == null || isHttpUrl(value), 'URL must be an http or https URL');

/**
 * PF2: a `YYYY-MM` month no later than the current KST month. Absent stays absent, `null` or `''`
 * becomes `null` (cleared), anything else stays the month string — conversion to an instant is the
 * service's job, so cross-field checks can compare strings.
 */
const optionalMonth = z
  .string()
  .trim()
  .nullish()
  .transform(emptyToNull)
  .superRefine((value, ctx) => {
    if (value == null) return;
    if (!isKstMonth(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONTH_MESSAGES.format });
    } else if (value > kstMonthString(new Date())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONTH_MESSAGES.future });
    }
  });

const requiredMonth = z
  .string({ required_error: MONTH_MESSAGES.format })
  .trim()
  .superRefine((value, ctx) => {
    if (!isKstMonth(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONTH_MESSAGES.format });
    } else if (value > kstMonthString(new Date())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONTH_MESSAGES.future });
    }
  });

/**
 * PF9 `skills`: repeated multipart fields (an array), one comma-separated value, or a JSON array of
 * strings. A non-string entry is a 400 — `normalizeSkillList` would throw on it, which is
 * 알려진 불일치 D16 (#11) on the pre-existing routes; this route does not have it. Normalized and de-duplicated before the limits apply.
 */
const skillList = z
  .union([z.string(), z.array(z.string({ invalid_type_error: 'Skills must be strings' })), z.null()])
  .transform((value) => normalizeSkillList(value ?? []))
  .superRefine((skills, ctx) => {
    if (skills.length > PORTFOLIO_LIMITS.skills) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${PORTFOLIO_LIMITS.skills} skills are allowed` });
    } else if (skills.some((skill) => skill.length > PORTFOLIO_LIMITS.skill)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Each skill must be at most ${PORTFOLIO_LIMITS.skill} characters` });
    }
  });

/** `true`/`false` as a boolean or, in multipart, as a string. */
const formBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])], {
    errorMap: () => ({ message: 'Must be true or false' }),
  })
  .transform((value) => value === true || value === 'true');

type MonthRange = { start?: string | null; end?: string | null };

/**
 * PF9/PF13's cross-field month rules, reported on the end field. Only runs on values that already
 * passed their own checks, so a malformed month is reported once, by its field.
 */
export function monthRangeIssue({ start, end }: MonthRange): string | null {
  if (!end || !isKstMonth(end)) return null;
  if (!start) return MONTH_MESSAGES.startRequired;
  if (!isKstMonth(start)) return null;
  return end < start ? MONTH_MESSAGES.order : null;
}

// ---------------------------------------------------------------------------------------------
// Portfolio (PF9, PF10, PF12)
// ---------------------------------------------------------------------------------------------

const portfolioFields = {
  title: requiredText('Title', PORTFOLIO_LIMITS.title),
  description: optionalText(`Description must be at most ${PORTFOLIO_LIMITS.description} characters`, PORTFOLIO_LIMITS.description),
  url: optionalUrl,
  role: optionalText(`Role must be at most ${PORTFOLIO_LIMITS.role} characters`, PORTFOLIO_LIMITS.role),
  skills: skillList,
  startedAt: optionalMonth,
  endedAt: optionalMonth,
};

/** PF9. `skills` defaults to `[]`; the months default to `null`. */
export const portfolioCreateBody = z
  .object({
    ...portfolioFields,
    skills: portfolioFields.skills.optional().transform((value) => value ?? []),
  })
  .superRefine((body, ctx) => {
    const issue = monthRangeIssue({ start: body.startedAt, end: body.endedAt });
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endedAt'], message: issue });
  });

/**
 * PF10. Every field optional; only present ones change. The month order is checked later, on the
 * stored row merged with the patch (after existence and ownership).
 */
export const portfolioPatchBody = z.object({
  title: portfolioFields.title.optional(),
  description: portfolioFields.description,
  url: portfolioFields.url,
  role: portfolioFields.role,
  skills: portfolioFields.skills.optional(),
  startedAt: portfolioFields.startedAt,
  endedAt: portfolioFields.endedAt,
  removeImage: formBoolean.optional(),
});

/** PF12. Whether `ids` is a permutation of the caller's items is checked under the lock. */
export const portfolioOrderBody = z.object({
  ids: z.array(z.string()),
});

export type PortfolioCreateInput = z.infer<typeof portfolioCreateBody>;
export type PortfolioPatchInput = z.infer<typeof portfolioPatchBody>;

// ---------------------------------------------------------------------------------------------
// Careers (PF13, PF14)
// ---------------------------------------------------------------------------------------------

const careerFields = {
  company: requiredText('Company', CAREER_LIMITS.company),
  position: requiredText('Position', CAREER_LIMITS.position),
  employmentType: z.enum(['FULL_TIME', 'CONTRACT', 'FREELANCE', 'INTERN']),
  startDate: requiredMonth,
  // Absent, `null` or `''` → a current position.
  endDate: optionalMonth,
  description: optionalText(`Description must be at most ${CAREER_LIMITS.description} characters`, CAREER_LIMITS.description),
};

/** PF13. */
export const careerCreateBody = z
  .object({
    ...careerFields,
    endDate: careerFields.endDate.transform((value) => value ?? null),
  })
  .superRefine((body, ctx) => {
    const issue = monthRangeIssue({ start: body.startDate, end: body.endDate });
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: issue });
  });

/** PF14. The month order is checked on the merged row after existence and ownership. */
export const careerPatchBody = z.object({
  company: careerFields.company.optional(),
  position: careerFields.position.optional(),
  employmentType: careerFields.employmentType.optional(),
  startDate: careerFields.startDate.optional(),
  endDate: careerFields.endDate,
  description: careerFields.description,
});

export type CareerCreateInput = z.infer<typeof careerCreateBody>;
export type CareerPatchInput = z.infer<typeof careerPatchBody>;

// ---------------------------------------------------------------------------------------------
// Recommendations (RC1)
// ---------------------------------------------------------------------------------------------

export const RECOMMENDATION_DEFAULT_LIMIT = 10;
export const RECOMMENDATION_MAX_LIMIT = 20;

/** RC1: `limit` ≥ 1, default 10, a larger value capped at 20. There is no `page`. */
export const recommendationQuery = z.object({
  limit: queryInt({ min: 1, fallback: RECOMMENDATION_DEFAULT_LIMIT })
    .transform((limit) => Math.min(limit, RECOMMENDATION_MAX_LIMIT)),
});

export type RecommendationQuery = z.infer<typeof recommendationQuery>;
