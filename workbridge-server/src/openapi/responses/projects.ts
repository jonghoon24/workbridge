import { z } from '../../lib/zod';
import { count, dateTime, id, paginationMeta, projectStatusEnum, won } from './common';

/** A `Project` row as Prisma returns it. `deletedAt` is always `null` on the routes that return it. */
export const projectFields = {
  id,
  title: z.string(),
  description: z.string(),
  category: z.string(),
  budget: won,
  recruitmentStartDate: dateTime.nullable(),
  deadline: dateTime,
  requiredSkills: z.array(z.string()),
  status: projectStatusEnum,
  clientId: id,
  deletedAt: dateTime.nullable(),
  createdAt: dateTime,
};

export const project = z.object(projectFields).openapi('Project');

const applicationCount = z.object({ applications: count }).openapi({ description: '지원 수' });

/** The client card of the project list and bookmarks. */
const projectClient = z.object({
  id,
  name: z.string(),
  companyName: z.string().nullable(),
  profileImage: z.string().nullable(),
});

/** One entry of `GET /api/projects`. */
export const projectListItem = z
  .object({ ...projectFields, client: projectClient, _count: applicationCount })
  .openapi('ProjectListItem');

export const projectList = z.object({ projects: z.array(projectListItem), meta: paginationMeta });

/** `GET /api/users/me/projects`. */
export const myProject = z.object({ ...projectFields, _count: applicationCount });

/** `GET /api/users/me/bookmarks`: the bookmarked project, newest bookmark first. */
export const bookmarkedProject = z.object({
  ...projectFields,
  client: projectClient,
  _count: applicationCount,
  isBookmarked: z.literal(true),
  bookmarkedAt: dateTime,
});

/** One row of `PricingAnalysis.features`, normalized before it was stored (`analyzeProject`). */
const pricingFeature = z.object({
  name: z.string(),
  description: z.string(),
  estimatedCost: won,
  rationale: z.string(),
  duration: z.string().nullable(),
});

export const pricingAnalysis = z
  .object({
    id,
    projectId: id,
    features: z.array(pricingFeature),
    totalAmount: won.openapi({ description: '기능별 금액의 합계' }),
    summary: z.string().nullable(),
    marketReference: z.string().nullable(),
    createdAt: dateTime,
  })
  .openapi('PricingAnalysis');

/** `GET /api/projects/:id`. */
export const projectDetail = z
  .object({
    ...projectFields,
    client: projectClient.extend({ businessField: z.string().nullable() }),
    _count: applicationCount,
    pricingAnalysis: pricingAnalysis.nullable(),
  })
  .openapi('ProjectDetail');

export const bookmarkState = z.object({ bookmarked: z.boolean() });

/** RC3–RC5 (`recommendFreelancers` in `lib/recommendations.ts`). */
export const recommendedFreelancers = z.object({
  freelancers: z.array(
    z.object({
      id,
      name: z.string(),
      profileImage: z.string().nullable(),
      activityCategory: z.string().nullable(),
      experienceYears: z.number().int().nullable(),
      hourlyRate: won.nullable(),
      skills: z.array(z.string()),
      score: z.number().min(0).max(100).openapi({ description: '0–100, 소수 둘째 자리' }),
      matchedSkills: z.array(z.string()),
      avgRating: z.number().nullable(),
      reviewCount: count,
      portfolioPreview: z.array(z.object({ id, title: z.string(), imageUrl: z.string().nullable() })).max(3),
    }),
  ),
});
