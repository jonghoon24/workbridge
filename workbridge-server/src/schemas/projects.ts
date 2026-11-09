import { z } from 'zod';
import type { ProjectStatus } from '@prisma/client';

import { normalizeSkillList } from '../lib/skills';
import { kstDateToEndOfDay, startOfKstDay } from '../lib/time';
import { bodyEnum, bodyNumber, queryEnum, queryInt, queryNumber, queryString, requiredString } from './common';
import { MAX_PAGE, MAX_PAGE_SIZE } from './pagination';

/**
 * Request schemas of the project routes (BEHAVIOR.md § Projects, rules 8 and 12). Failures are
 * `<path>: <message>` (rule 12); the messages below are the `<message>` half.
 */

// ---------------------------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------------------------

const SKILLS_MESSAGE = 'must be a string or a list of strings';

/**
 * Skills as a comma-separated string or a list of strings — what `normalizeSkillList` accepts.
 * Anything else (a number, `[1, 2]`, a nested list, an object) is a 400 here rather than a
 * `TypeError` in `normalizeSkillList` (D16).
 */
const skillsInput = z.union([z.string(), z.array(z.string())], {
  errorMap: (_issue, ctx) => ({ message: ctx.data === undefined ? 'Required' : SKILLS_MESSAGE }),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a valid date';

/**
 * A project date. A bare `YYYY-MM-DD` (what the project form's date input sends) is a **KST
 * calendar day**: as a `deadline` it lasts until that day ends (23:59:59.999 KST), as a
 * `recruitmentStartDate` it begins at 00:00 KST. `new Date('YYYY-MM-DD')` would read it as 00:00
 * UTC = 09:00 KST, closing a project due "today" the moment it is created after 9 am. Anything
 * else must parse as an instant.
 */
function projectDate(dateOnlyAs: 'startOfDay' | 'endOfDay') {
  return z.string({ invalid_type_error: DATE_MESSAGE }).transform((value, ctx): Date => {
    if (DATE_ONLY.test(value)) {
      try {
        const endOfDay = kstDateToEndOfDay(value);
        return dateOnlyAs === 'endOfDay' ? endOfDay : startOfKstDay(endOfDay);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: DATE_MESSAGE });
        return z.NEVER;
      }
    }

    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: DATE_MESSAGE });
      return z.NEVER;
    }
    return parsed;
  });
}

const BUDGET_MESSAGE = 'must be a non-negative number';

/** A non-negative number of won; `0` is a valid budget (D15). Fractions are allowed (Float). */
const budget = bodyNumber(BUDGET_MESSAGE).superRefine((value, ctx) => {
  if (value < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: BUDGET_MESSAGE });
});

// ---------------------------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------------------------

export const PROJECT_LIST_DEFAULT_LIMIT = 10;

/**
 * Rule 12 query conventions: an empty value is absent, a repeated parameter (other than
 * `skills`, which is a list) is a 400, and `page`/`limit` are plain integers. `page` is bounded
 * like CT2 so `skip` cannot overflow into a Prisma 500.
 */
export const projectListQuery = z
  .object({
    sort: queryEnum(['latest', 'deadline', 'budget'] as const, 'latest'),
    status: queryEnum(['ALL', 'UPCOMING', 'OPEN', 'CLOSED'] as const, 'OPEN'),
    page: queryInt({ min: 1, max: MAX_PAGE, fallback: 1 }),
    limit: queryInt({ min: 1, fallback: PROJECT_LIST_DEFAULT_LIMIT }).transform((limit) => Math.min(limit, MAX_PAGE_SIZE)),
    minBudget: queryNumber({ min: 0 }),
    maxBudget: queryNumber({ min: 0 }),
    search: queryString(),
    category: queryString(),
    // `?skills=React,Vue`, `?skills=React&skills=Vue` and `?skills[]=React` are all lists.
    skills: skillsInput.optional(),
  })
  .superRefine((query, ctx) => {
    if (query.minBudget !== undefined && query.maxBudget !== undefined && query.minBudget > query.maxBudget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minBudget'], message: 'must not be greater than maxBudget' });
    }
  });

export type ProjectListQuery = z.infer<typeof projectListQuery>;

// ---------------------------------------------------------------------------------------------
// POST /api/projects, PATCH /api/projects/:id
// ---------------------------------------------------------------------------------------------

/**
 * `recruitmentStartDate` defaults to now (the controller's job, so "now" is request time); sent
 * empty or `null` it is absent too. `requiredSkills` is normalized and de-duplicated; omitted or
 * `null` → `[]`. Whether `recruitmentStartDate <= deadline` is the controller's check, shared
 * with PATCH, which compares against stored dates.
 */
export const projectCreateBody = z.object({
  title: requiredString(),
  description: requiredString(),
  category: requiredString(),
  budget,
  recruitmentStartDate: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    projectDate('startOfDay').optional(),
  ),
  deadline: projectDate('endOfDay'),
  requiredSkills: skillsInput.nullish().transform((value) => normalizeSkillList(value ?? [])),
});

/**
 * Every field optional; only present ones change. Once the project has applications, sending
 * `budget`, `recruitmentStartDate` or `deadline` at all is refused by the controller.
 */
export const projectUpdateBody = z.object({
  title: requiredString().optional(),
  description: requiredString().optional(),
  category: requiredString().optional(),
  budget: budget.optional(),
  recruitmentStartDate: projectDate('startOfDay').optional(),
  deadline: projectDate('endOfDay').optional(),
  requiredSkills: skillsInput
    .nullish()
    .transform((value) => (value === undefined ? undefined : normalizeSkillList(value ?? []))),
});

// ---------------------------------------------------------------------------------------------
// PATCH /api/projects/:id/status
// ---------------------------------------------------------------------------------------------

const PROJECT_STATUSES = [
  'UPCOMING',
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'CLOSED',
] as const satisfies readonly ProjectStatus[];

/**
 * Any `ProjectStatus`; whether the transition is allowed is the controller's check, after the
 * ownership check, with its own `Cannot transition from X to Y`.
 */
export const projectStatusBody = z.object({
  status: bodyEnum(PROJECT_STATUSES),
});
