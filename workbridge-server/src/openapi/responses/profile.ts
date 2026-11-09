import { z } from '../../lib/zod';
import { count, dateTime, employmentTypeEnum, id, month, projectStatusEnum, won } from './common';

/** `serializePortfolioItem` (`services/portfolio.service.ts`, PF3). */
export const portfolioItem = z
  .object({
    id,
    userId: id,
    title: z.string(),
    description: z.string().nullable(),
    url: z.string().nullable(),
    imageUrl: z.string().nullable(),
    role: z.string().nullable(),
    skills: z.array(z.string()),
    startedAt: month.nullable(),
    endedAt: month.nullable(),
    sortOrder: z.number().int(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .openapi('PortfolioItem');

/** `serializeCareer` (`services/careers.service.ts`, PF4). `endDate: null` is a current position. */
export const career = z
  .object({
    id,
    userId: id,
    company: z.string(),
    position: z.string(),
    employmentType: employmentTypeEnum,
    startDate: month,
    endDate: month.nullable(),
    description: z.string().nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .openapi('Career');

/** PF6: merged career months. Display only. */
export const careerSummary = z
  .object({
    totalMonths: count,
    years: count,
    months: z.number().int().min(0).max(11),
  })
  .openapi('CareerSummary');

export const portfolioList = z.object({ items: z.array(portfolioItem) });
export const portfolioItemBody = z.object({ item: portfolioItem });
export const careerList = z.object({ careers: z.array(career), careerSummary });
export const careerBody = z.object({ career });
export const deletedBody = z.object({ id, deleted: z.literal(true) });

/** PF21. `isComplete` (the rule 4 gate) and `percent` are independent. */
export const profileCompletion = z
  .object({
    isComplete: z.boolean(),
    percent: z.number().int().min(0).max(100),
    items: z.array(z.object({ key: z.string(), weight: z.number().int(), done: z.boolean() })),
  })
  .openapi('ProfileCompletion');

/** RC6–RC8 (`recommendProjects` in `lib/recommendations.ts`). */
export const recommendedProjects = z.object({
  projects: z.array(
    z.object({
      id,
      title: z.string(),
      category: z.string(),
      budget: won,
      deadline: dateTime,
      requiredSkills: z.array(z.string()),
      status: projectStatusEnum,
      createdAt: dateTime,
      client: z.object({ id, name: z.string(), companyName: z.string().nullable() }),
      score: z.number().min(0).max(100).openapi({ description: '0–100, 소수 둘째 자리' }),
      matchedSkills: z.array(z.string()),
    }),
  ),
});
