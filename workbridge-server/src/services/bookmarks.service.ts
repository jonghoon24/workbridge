import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * Bookmarks (docs/domain/projects-contracts.md "북마크"): one project's bookmark state, adding and
 * removing it (`/api/projects/:id/bookmark`, on the projects router), and the ids for lists.
 */

/**
 * The live project a bookmark route acts on; a missing or soft-deleted project, or one whose client
 * is soft-deleted, is 404 — as on the detail page.
 */
async function findBookmarkableProject(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, client: { deletedAt: null } },
    select: { id: true },
  });

  if (!project) {
    throw new AppError('Project not found', 404);
  }

  return project;
}

/** `GET /api/projects/:id/bookmark`. */
export async function getBookmarkState(projectId: string, userId: string) {
  await findBookmarkableProject(projectId);

  const bookmark = await prisma.projectBookmark.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId,
      },
    },
    select: { id: true },
  });

  return { bookmarked: !!bookmark };
}

/** `POST /api/projects/:id/bookmark`. Idempotent. */
export async function addBookmark(projectId: string, userId: string) {
  await findBookmarkableProject(projectId);

  // `INSERT … ON CONFLICT DO NOTHING`, not `upsert`: Prisma's upsert on a compound key is
  // find-then-insert, so an overlapping request for the same bookmark hit P2002 (a 500). An
  // existing row is left as it is (same id and createdAt).
  await prisma.projectBookmark.createMany({
    data: [{ projectId, userId }],
    skipDuplicates: true,
  });

  return { bookmarked: true };
}

/** `DELETE /api/projects/:id/bookmark`. Idempotent. */
export async function removeBookmark(projectId: string, userId: string) {
  await findBookmarkableProject(projectId);

  // No bookmark on a live project is still a success (idempotent).
  await prisma.projectBookmark.deleteMany({
    where: {
      projectId,
      userId,
    },
  });

  return { bookmarked: false };
}

/**
 * The ids of the live projects `userId` has bookmarked, newest bookmark first. A list screen
 * fetches this once and marks its cards, instead of asking about each card. A soft-deleted
 * project, or one whose client is soft-deleted, is left out, as in the bookmark list.
 */
export async function listBookmarkedProjectIds(userId: string) {
  const bookmarks = await prisma.projectBookmark.findMany({
    where: { userId, project: { deletedAt: null, client: { deletedAt: null } } },
    select: { projectId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  return { projectIds: bookmarks.map((bookmark) => bookmark.projectId) };
}
