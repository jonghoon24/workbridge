import type { NextFunction, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
// Value import, not `import type` — `instanceof` needs the runtime object.
import { Prisma } from '@prisma/client';
import type { AuthedRequest } from '../types/index';
import type { ReviewInput } from '../schemas/reviews';

export async function createReview(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `reviewBody`: a 1–5 integer rating and a string array of tags.
    const { contractId, revieweeId, rating, content, tags } = req.body as ReviewInput;

    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id && contract.freelancerId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    if (contract.status !== 'COMPLETED') {
      throw new AppError('Reviews can only be written after project completion', 400);
    }

    // Verify reviewee is the other party
    const expectedRevieweeId = contract.clientId === req.user.id
      ? contract.freelancerId
      : contract.clientId;

    if (revieweeId !== expectedRevieweeId) {
      throw new AppError('Invalid reviewee', 400);
    }

    try {
      const review = await prisma.review.create({
        data: {
          contractId,
          reviewerId: req.user.id,
          revieweeId,
          rating,
          content,
          tags,
        },
      });

      res.status(201).json(review);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('You have already reviewed this contract', 409);
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// Public route (`GET /api/reviews/users/:id` is not behind `authenticate`) — `req.user` is
// unset at runtime here, so this handler must not read it.
export async function getUserReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const reviews = await prisma.review.findMany({
      where: { revieweeId: req.params.id },
      include: {
        reviewer: { select: { id: true, name: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(reviews);
  } catch (err) {
    next(err);
  }
}
