import prisma from '../lib/prisma';

/**
 * Bookmark lookups for lists (docs/domain/projects-contracts.md "북마크"). Adding and removing a
 * bookmark stays on the projects router (`/api/projects/:id/bookmark`).
 */

/**
 * The ids of the live projects `userId` has bookmarked, newest bookmark first. A list screen
 * fetches this once and marks its cards, instead of asking about each card. A soft-deleted
 * project is left out, as in the bookmark list.
 */
export async function listBookmarkedProjectIds(userId: string) {
  const bookmarks = await prisma.projectBookmark.findMany({
    where: { userId, project: { deletedAt: null } },
    select: { projectId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  return { projectIds: bookmarks.map((bookmark) => bookmark.projectId) };
}
