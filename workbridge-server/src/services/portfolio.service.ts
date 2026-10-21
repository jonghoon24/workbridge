import type { PortfolioItem, Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { kstMonthOrNull, kstMonthToDate } from '../lib/time';
import { storeUploadedFile } from '../middlewares/attachmentUpload';
import { monthRangeIssue, PORTFOLIO_LIMITS } from '../schemas/profile';
import type { PortfolioCreateInput, PortfolioPatchInput } from '../schemas/profile';
import type { PrismaTransactionClient } from '../types/index';

/** BEHAVIOR.md "Portfolio and careers", PF1–PF12, PF16. */

const NOT_FOUND = 'Portfolio item not found';
const LIMIT_REACHED = `Portfolio is limited to ${PORTFOLIO_LIMITS.items} items`;
const BAD_ORDER = 'ids: Must list each of your portfolio items exactly once';

/** PF5. */
export const PORTFOLIO_ORDER: Prisma.PortfolioItemOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
];

/** PF3: months as `YYYY-MM`, never timestamps (PF2). */
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

/**
 * PF8: the caller's `User` row lock (the one PA7 and S17 take), always a transaction's first
 * statement. Serializes this user's portfolio creates, reorders and deletes, and career creates.
 */
export async function lockUserRow(tx: PrismaTransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}

/** `YYYY-MM` (validated) → the stored instant; `null` stays `null`. */
function toMonth(value: string | null | undefined): Date | null {
  return value == null ? null : kstMonthToDate(value);
}

/** The items of `userId` in PF5 order. The caller has already checked the user is visible. */
export async function listPortfolioItems(userId: string) {
  const items = await prisma.portfolioItem.findMany({ where: { userId }, orderBy: PORTFOLIO_ORDER });
  return items.map(serializePortfolioItem);
}

/** PF16. */
export async function getPublicPortfolio(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
  if (!user) throw new AppError('User not found', 404);
  return { items: await listPortfolioItems(userId) };
}

/** PF9. */
export async function createPortfolioItem(
  userId: string,
  input: PortfolioCreateInput,
  image: Express.Multer.File | undefined,
) {
  // Checked once before the image is stored, so a full portfolio does not upload for nothing…
  if (await prisma.portfolioItem.count({ where: { userId } }) >= PORTFOLIO_LIMITS.items) {
    throw new AppError(LIMIT_REACHED, 409);
  }

  // …and the upload happens outside the transaction: holding the row lock across a network call
  // would stall this user's other writes. A request that then loses the race leaves its image
  // unreferenced (PF9).
  const imageUrl = image ? (await storeUploadedFile(image, 'portfolio')).url : null;

  const item = await prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);

    // …and again under the lock (PF8): two creates at 19 items end at 20 and one 409.
    const [count, last] = await Promise.all([
      tx.portfolioItem.count({ where: { userId } }),
      tx.portfolioItem.findFirst({ where: { userId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } }),
    ]);
    if (count >= PORTFOLIO_LIMITS.items) throw new AppError(LIMIT_REACHED, 409);

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
  });

  return { item: serializePortfolioItem(item) };
}

/** PF7's existence-then-ownership check, shared by PATCH and DELETE. */
function assertOwnItem<T extends { userId: string }>(item: T | null, userId: string): T {
  if (!item) throw new AppError(NOT_FOUND, 404);
  if (item.userId !== userId) throw new AppError('Not authorized', 403);
  return item;
}

/** PF10. Validation (including the image/removeImage conflict) has already run. */
export async function updatePortfolioItem(
  userId: string,
  itemId: string,
  input: PortfolioPatchInput,
  image: Express.Multer.File | undefined,
) {
  const stored = assertOwnItem(await prisma.portfolioItem.findUnique({ where: { id: itemId } }), userId);

  // The month order is checked on the stored row merged with the patch.
  const merged = {
    start: input.startedAt !== undefined ? input.startedAt : kstMonthOrNull(stored.startedAt),
    end: input.endedAt !== undefined ? input.endedAt : kstMonthOrNull(stored.endedAt),
  };
  const monthIssue = monthRangeIssue(merged);
  if (monthIssue) throw new AppError(`endedAt: ${monthIssue}`, 400);

  const data: Prisma.PortfolioItemUpdateManyMutationInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.url !== undefined) data.url = input.url;
  if (input.role !== undefined) data.role = input.role;
  if (input.skills !== undefined) data.skills = input.skills;
  if (input.startedAt !== undefined) data.startedAt = toMonth(input.startedAt);
  if (input.endedAt !== undefined) data.endedAt = toMonth(input.endedAt);
  if (input.removeImage) data.imageUrl = null;
  // The replaced or removed file stays in storage (PF10).
  if (image) data.imageUrl = (await storeUploadedFile(image, 'portfolio')).url;

  // No lock: an update changes neither the count nor the order (PF8). An item deleted since the
  // read above is a 404.
  // An empty patch writes nothing (Prisma skips an `updateMany` without data and reports 0 rows).
  const { count } = Object.keys(data).length
    ? await prisma.portfolioItem.updateMany({ where: { id: itemId, userId }, data })
    : { count: 1 };
  const item = count === 1 ? await prisma.portfolioItem.findUnique({ where: { id: itemId } }) : null;
  if (!item) throw new AppError(NOT_FOUND, 404);

  return { item: serializePortfolioItem(item) };
}

/** PF11: under PF8's lock, so it serializes with a reorder. Other items keep their `sortOrder`. */
export async function deletePortfolioItem(userId: string, itemId: string) {
  return prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);
    // Read after the lock: an item deleted by a concurrent request while waiting is a 404.
    assertOwnItem(await tx.portfolioItem.findUnique({ where: { id: itemId }, select: { userId: true } }), userId);
    await tx.portfolioItem.delete({ where: { id: itemId } });
    return { id: itemId, deleted: true as const };
  });
}

/** PF12. */
export async function reorderPortfolio(userId: string, ids: string[]) {
  return prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);

    const owned = await tx.portfolioItem.findMany({ where: { userId }, select: { id: true } });
    const ownedIds = new Set(owned.map((item) => item.id));
    const isPermutation = ids.length === ownedIds.size
      && new Set(ids).size === ids.length
      && ids.every((id) => ownedIds.has(id));
    if (!isPermutation) throw new AppError(BAD_ORDER, 400);

    // At most 20 rows, all locked out from concurrent creates and deletes by the user-row lock.
    for (const [index, id] of ids.entries()) {
      await tx.portfolioItem.update({ where: { id }, data: { sortOrder: index } });
    }

    const items = await tx.portfolioItem.findMany({ where: { userId }, orderBy: PORTFOLIO_ORDER });
    return { items: items.map(serializePortfolioItem) };
  });
}
