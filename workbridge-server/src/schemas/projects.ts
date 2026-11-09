import { z } from '../lib/zod';
import type { ProjectStatus } from '@prisma/client';

import { normalizeSkillList } from '../lib/skills';
import { kstDateToEndOfDay, startOfKstDay } from '../lib/time';
import { bodyEnum, bodyWholeWon, queryEnum, queryInt, queryNumber, queryString, requiredString } from './common';
import { MAX_PAGE, MAX_PAGE_SIZE } from './pagination';

/**
 * Request schemas of the project routes. Failures are 400
 * `<path>: <message>`: body messages are sentences (`budget: Budget is required`), query
 * messages keep the `common.ts` query style (`page: must be an integer`).
 */

// ---------------------------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------------------------

/**
 * Skills as a comma-separated string or a list of strings — what `normalizeSkillList` accepts.
 * Anything else (a number, `[1, 2]`, a nested list, an object) is a 400 here rather than a
 * `TypeError` in `normalizeSkillList`. Both uses are optional.
 */
function skillsInput(message: string) {
  return z.union([z.string(), z.array(z.string())], { errorMap: () => ({ message }) });
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A project date. A bare `YYYY-MM-DD` (what the project form's date input sends) is a **KST
 * calendar day**: as a `deadline` it lasts until that day ends (23:59:59.999 KST), as a
 * `recruitmentStartDate` it begins at 00:00 KST. `new Date('YYYY-MM-DD')` would read it as 00:00
 * UTC = 09:00 KST, closing a project due "today" the moment it is created after 9 am. Anything
 * else must parse as an instant.
 */
function projectDate(label: string, dateOnlyAs: 'startOfDay' | 'endOfDay') {
  const DATE_MESSAGE = `${label} must be a valid date`;
  return z.string({ required_error: `${label} is required`, invalid_type_error: DATE_MESSAGE }).transform((value, ctx): Date => {
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
  }).openapi({
    description: '`YYYY-MM-DD`(KST 날짜) 또는 ISO 8601 시각.',
    example: '2026-12-31',
  });
}

/** A positive whole number of won: a budget is at least 1 won (`0` is a 400). */
const budget = bodyWholeWon('Budget', { min: 1 });

const SKILLS_BODY_MESSAGE = 'Required skills must be a string or a list of strings';

// ---------------------------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------------------------

export const PROJECT_LIST_DEFAULT_LIMIT = 10;

/**
 * The shared query conventions: an empty value is absent, a repeated parameter (other than
 * `skills`, which is a list) is a 400, and `page`/`limit` are plain integers. `page` is bounded
 * like `pageQuery` (`MAX_PAGE`) so `skip` cannot overflow into a Prisma 500.
 */
export const projectListQuery = z
  .object({
    sort: queryEnum(['latest', 'deadline', 'budget'] as const, 'latest'),
    status: queryEnum(['ALL', 'UPCOMING', 'OPEN', 'CLOSED'] as const, 'OPEN'),
    page: queryInt({ min: 1, max: MAX_PAGE, fallback: 1 }),
    limit: queryInt({ min: 1, fallback: PROJECT_LIST_DEFAULT_LIMIT })
      .transform((limit) => Math.min(limit, MAX_PAGE_SIZE))
      .openapi({ description: `${MAX_PAGE_SIZE}보다 크면 ${MAX_PAGE_SIZE}로 줄인다.` }),
    minBudget: queryNumber({ min: 0 }),
    maxBudget: queryNumber({ min: 0 }),
    search: queryString().openapi({ description: '제목·설명에 들어 있는 글자(대소문자 무시)' }),
    category: queryString().openapi({ description: '카테고리(정확히 일치)' }),
    // `?skills=React,Vue`, `?skills=React&skills=Vue` and `?skills[]=React` are all lists.
    skills: skillsInput('must be a string or a list of strings')
      .optional()
      .openapi({ description: '하나라도 요구하는 프로젝트. `skills=React,Vue`, `skills=React&skills=Vue` 모두 된다.' }),
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
  title: requiredString('Project title'),
  description: requiredString('Project description'),
  category: requiredString('Category'),
  budget,
  recruitmentStartDate: z
    .preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      projectDate('Recruitment start date', 'startOfDay').optional(),
    )
    .openapi({ description: '생략하거나 빈 값이면 지금. `YYYY-MM-DD`(KST 날짜) 또는 ISO 8601 시각.' }),
  deadline: projectDate('Deadline', 'endOfDay'),
  requiredSkills: skillsInput(SKILLS_BODY_MESSAGE).nullish().transform((value) => normalizeSkillList(value ?? [])),
});

/**
 * Every field optional; only present ones change. Once the project has applications, sending
 * `budget`, `recruitmentStartDate` or `deadline` at all is refused by the controller.
 */
export const projectUpdateBody = z.object({
  title: requiredString('Project title').optional(),
  description: requiredString('Project description').optional(),
  category: requiredString('Category').optional(),
  budget: budget.optional(),
  recruitmentStartDate: projectDate('Recruitment start date', 'startOfDay').optional(),
  deadline: projectDate('Deadline', 'endOfDay').optional(),
  requiredSkills: skillsInput(SKILLS_BODY_MESSAGE)
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
  status: bodyEnum('Project status', PROJECT_STATUSES),
});
