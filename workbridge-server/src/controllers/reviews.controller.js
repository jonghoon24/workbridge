import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { Prisma } from '@prisma/client';

export async function createReview(req, res, next) {
  try {
    const { contractId, revieweeId, rating, content, tags } = req.body;

    if (!contractId || !revieweeId || !rating || !content) {
      throw new AppError('All fields are required', 400);
    }

    if (rating < 1 || rating > 5) {
      throw new AppError('Rating must be between 1 and 5', 400);
    }

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
          rating: parseInt(rating),
          content,
          tags: Array.isArray(tags) ? tags : [],
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

export async function getUserReviews(req, res, next) {
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
