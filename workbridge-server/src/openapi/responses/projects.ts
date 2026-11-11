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

/** `GET /api/users/me/bookmarks/ids`: the bookmarked live projects' ids, newest bookmark first. */
export const bookmarkedProjectIds = z.object({
  projectIds: z.array(z.string()),
});

/** `GET /api/projects/:id`. */
export const projectDetail = z
  .object({
    ...projectFields,
    client: projectClient.extend({ businessField: z.string().nullable() }),
    _count: applicationCount,
  })
  .openapi('ProjectDetail');

export const bookmarkState = z.object({ bookmarked: z.boolean() });
