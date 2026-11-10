import { z } from '../../lib/zod';
import { dateTime, id, userCard } from './common';

/** A `Review` row. */
export const reviewFields = {
  id,
  contractId: id,
  reviewerId: id,
  revieweeId: id,
  rating: z.number().int().min(1).max(5),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: dateTime,
};

export const review = z.object(reviewFields).openapi('Review');

/** `GET /api/reviews/users/:id` and `GET /api/users/:id/reviews`, newest first. */
export const receivedReview = z.object({ ...reviewFields, reviewer: userCard }).openapi('ReceivedReview');
