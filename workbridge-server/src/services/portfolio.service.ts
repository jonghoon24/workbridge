import type { PortfolioItem, Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError, invalidField } from '../lib/errors';
import { kstMonthOrNull, kstMonthToDate } from '../lib/time';
import { lockActiveUserRow } from '../lib/locks';
import { publicObjectPath } from '../lib/attachmentStorage';
import { enqueueJob } from '../jobs/queue';
import { storeUploadedFile } from '../middlewares/attachmentUpload';
import { monthRangeIssue, PORTFOLIO_LIMITS } from '../schemas/profile';
import type { PortfolioCreateInput, PortfolioPatchInput } from '../schemas/profile';

/** Portfolio items: serialization, order, the public list and the writes (docs/domain/accounts.md). */

const NOT_FOUND = 'Portfolio item not found';
const LIMIT_REACHED = `Portfolio is limited to ${PORTFOLIO_LIMITS.items} items`;
const BAD_ORDER = 'ids: Must list each of your portfolio items exactly once';

/**
 * An image stored for a request whose user withdrew meanwhile: no item refers to it, and its key
 * has no user id, so the withdrawal's file cleanup cannot find it. Hand it to that cleanup job,
 * which deletes it only because the user is withdrawn (for a live user it does nothing).
 */
async function discardImageOfWithdrawnUser(userId: string, imageUrl: string | null): Promise<void> {
  const path = publicObjectPath(imageUrl);
  if (!path) return;
  await enqueueJob(prisma, { type: 'account.deletePublicFiles', payload: { userId, paths: [path] } });
}

/** `sortOrder` ascending, then newest first, then `id`. */
export const PORTFOLIO_ORDER: Prisma.PortfolioItemOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
];

/** Months as `YYYY-MM`, never timestamps. */
export function serializePortfolioItem(item: PortfolioItem) {
  return {
    id: item.id,
    userId: item.userId,
    title: item.title,
    description: item.description,
    url: item.url,
    imageUrl: item.imageUrl,
    role: item.role,
    skills: item.skills,
    startedAt: kstMonthOrNull(item.startedAt),
    endedAt: kstMonthOrNull(item.endedAt),
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** `YYYY-MM` (validated) → the stored instant; `null` stays `null`. */
function toMonth(value: string | null | undefined): Date | null {
  return value == null ? null : kstMonthToDate(value);
}

/** The items of `userId` in `PORTFOLIO_ORDER`. The caller has already checked the user is visible. */
export async function listPortfolioItems(userId: string) {
  const items = await prisma.portfolioItem.findMany({ where: { userId }, orderBy: PORTFOLIO_ORDER });
  return items.map(serializePortfolioItem);
}

/** `GET /api/users/:id/portfolio`: 404 for a missing or soft-deleted user. */
export async function getPublicPortfolio(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found');
  return { items: await listPortfolioItems(userId) };
}

/** Create an item, appended after the caller's last one. */
export async function createPortfolioItem(
  userId: string,
  input: PortfolioCreateInput,
  image: Express.Multer.File | undefined,
) {
  // Checked once before the image is stored, so a full portfolio does not upload for nothing…
  if (await prisma.portfolioItem.count({ where: { userId } }) >= PORTFOLIO_LIMITS.items) {
    throw new AppError('PORTFOLIO_LIMIT_REACHED', LIMIT_REACHED);
  }

  // …and the upload happens outside the transaction: holding the row lock across a network call
  // would stall this user's other writes. A request that then loses the race leaves its image
  // unreferenced.
  const imageUrl = image ? (await storeUploadedFile(image, 'portfolio')).url : null;

  const item = await prisma.$transaction(async (tx) => {
    await lockActiveUserRow(tx, userId);

    // …and again under the user-row lock: two creates at 19 items end at 20 and one 409.
    const [count, last] = await Promise.all([
      tx.portfolioItem.count({ where: { userId } }),
      tx.portfolioItem.findFirst({ where: { userId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } }),
    ]);
    if (count >= PORTFOLIO_LIMITS.items) throw new AppError('PORTFOLIO_LIMIT_REACHED', LIMIT_REACHED);

    return tx.portfolioItem.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        url: input.url ?? null,
        imageUrl,
        role: input.role ?? null,
        skills: input.skills,
        startedAt: toMonth(input.startedAt),
        endedAt: toMonth(input.endedAt),
        sortOrder: last ? last.sortOrder + 1 : 0,
      },
    });
  }).catch(async (err: unknown) => {
    // Withdrew while the image was uploading: the lock check refused the write (401).
    if (err instanceof AppError && err.code === 'ACCOUNT_INACTIVE') await discardImageOfWithdrawnUser(userId, imageUrl);
    throw err;
  });

  return { item: serializePortfolioItem(item) };
}

/** Existence (404), then ownership (403), shared by PATCH and DELETE. */
function assertOwnItem<T extends { userId: string }>(item: T | null, userId: string): T {
  if (!item) throw new AppError('PORTFOLIO_ITEM_NOT_FOUND', NOT_FOUND);
  if (item.userId !== userId) throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  return item;
}

/** Partial update. Validation (including the image/removeImage conflict) has already run. */
export async function updatePortfolioItem(
  userId: string,
  itemId: string,
  input: PortfolioPatchInput,
  image: Express.Multer.File | undefined,
) {
  // Still validation, so before the existence check — the schema cannot see the file.
  if (image && input.removeImage) {
    throw invalidField('removeImage', 'CONFLICT', 'removeImage: Cannot upload and remove an image at once');
  }
  const stored = assertOwnItem(await prisma.portfolioItem.findUnique({ where: { id: itemId } }), userId);

  // The month order is checked on the stored row merged with the patch.
  const merged = {
    start: input.startedAt !== undefined ? input.startedAt : kstMonthOrNull(stored.startedAt),
    end: input.endedAt !== undefined ? input.endedAt : kstMonthOrNull(stored.endedAt),
  };
  const monthIssue = monthRangeIssue(merged);
  if (monthIssue) throw invalidField('endedAt', 'CONFLICT', `endedAt: ${monthIssue}`);

  const data: Prisma.PortfolioItemUpdateManyMutationInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.url !== undefined) data.url = input.url;
  if (input.role !== undefined) data.role = input.role;
  if (input.skills !== undefined) data.skills = input.skills;
  if (input.startedAt !== undefined) data.startedAt = toMonth(input.startedAt);
  if (input.endedAt !== undefined) data.endedAt = toMonth(input.endedAt);
  if (input.removeImage) data.imageUrl = null;
  // The replaced or removed file stays in storage.
  const storedImageUrl = image ? (await storeUploadedFile(image, 'portfolio')).url : null;
  if (storedImageUrl) data.imageUrl = storedImageUrl;

  // No lock: an update changes neither the count nor the order. An item deleted since the
  // read above is a 404.
  // An empty patch writes nothing (Prisma skips an `updateMany` without data and reports 0 rows).
  const { count } = Object.keys(data).length
    ? await prisma.portfolioItem.updateMany({ where: { id: itemId, userId }, data })
    : { count: 1 };
  const item = count === 1 ? await prisma.portfolioItem.findUnique({ where: { id: itemId } }) : null;
  if (!item) {
    // The item is gone; if a withdrawal deleted it, the image just stored belongs to no one.
    await discardImageOfWithdrawnUser(userId, storedImageUrl);
    throw new AppError('PORTFOLIO_ITEM_NOT_FOUND', NOT_FOUND);
  }

  return { item: serializePortfolioItem(item) };
}

/** Hard delete under the user-row lock, so it serializes with a reorder. Other items keep their `sortOrder`. */
export async function deletePortfolioItem(userId: string, itemId: string) {
  return prisma.$transaction(async (tx) => {
    await lockActiveUserRow(tx, userId);
    // Read after the lock: an item deleted by a concurrent request while waiting is a 404.
    assertOwnItem(await tx.portfolioItem.findUnique({ where: { id: itemId }, select: { userId: true } }), userId);
    await tx.portfolioItem.delete({ where: { id: itemId } });
    return { id: itemId, deleted: true as const };
  });
}

/** `ids` must list each of the caller's items exactly once; checked under the user-row lock. */
export async function reorderPortfolio(userId: string, ids: string[]) {
  return prisma.$transaction(async (tx) => {
    await lockActiveUserRow(tx, userId);

    const owned = await tx.portfolioItem.findMany({ where: { userId }, select: { id: true } });
    const ownedIds = new Set(owned.map((item) => item.id));
    const isPermutation = ids.length === ownedIds.size
      && new Set(ids).size === ids.length
      && ids.every((id) => ownedIds.has(id));
    if (!isPermutation) throw new AppError('PORTFOLIO_ORDER_MISMATCH', BAD_ORDER);

    // At most 20 rows, all locked out from concurrent creates and deletes by the user-row lock.
    for (const [index, id] of ids.entries()) {
      await tx.portfolioItem.update({ where: { id }, data: { sortOrder: index } });
    }

    const items = await tx.portfolioItem.findMany({ where: { userId }, orderBy: PORTFOLIO_ORDER });
    return { items: items.map(serializePortfolioItem) };
  });
}
