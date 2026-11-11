// Value import, not `import type` — `instanceof` needs the runtime object.
import { Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import type { ReviewInput } from '../schemas/reviews';

/** Mutual reviews after a completed contract (`POST /api/reviews`, `GET /api/reviews/users/:id`). */

/**
 * `reviewerId` reviews the other party of a completed contract. One review per reviewer and
 * contract: the unique `(contractId, reviewerId)` index turns a second one into a 409 — a single
 * insert, so the P2002 is caught here and not inside a transaction.
 */
export async function writeReview(reviewerId: string, input: ReviewInput) {
  const { contractId, revieweeId, rating, content, tags } = input;

  // A contract whose project is soft-deleted is invisible, as on every other contract path.
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
  });

  if (!contract) {
    throw new AppError('Contract not found', 404);
  }

  if (contract.clientId !== reviewerId && contract.freelancerId !== reviewerId) {
    throw new AppError('Not authorized', 403);
  }

  if (contract.status !== 'COMPLETED') {
    throw new AppError('Reviews can only be written after project completion', 400);
  }

  // Verify reviewee is the other party
  const expectedRevieweeId = contract.clientId === reviewerId
    ? contract.freelancerId
    : contract.clientId;

  if (revieweeId !== expectedRevieweeId) {
    throw new AppError('Invalid reviewee', 400);
  }

  try {
    return await prisma.review.create({
      data: {
        contractId,
        reviewerId,
        revieweeId,
        rating,
        content,
        tags,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('You have already reviewed this contract', 409);
    }
    throw err;
  }
}

/**
 * The reviews `userId` received, newest first. A soft-deleted user's received reviews are hidden
 * with their profile (an empty list, as for an unknown user). The reviews stay in the database.
 */
export function listReceivedReviews(userId: string) {
  return prisma.review.findMany({
    where: { revieweeId: userId, reviewee: { deletedAt: null } },
    include: {
      reviewer: { select: { id: true, name: true, profileImage: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
