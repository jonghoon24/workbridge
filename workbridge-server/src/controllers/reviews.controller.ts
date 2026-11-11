import type { NextFunction, Request, Response } from 'express';

import { listReceivedReviews, writeReview } from '../services/reviews.service';
import type { ReviewInput } from '../schemas/reviews';
import type { AuthedRequest } from '../types/index';

/** `POST /api/reviews`. The body was validated by `reviewBody`. */
export async function createReview(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await writeReview(req.user.id, req.body as ReviewInput));
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /api/reviews/users/:id`. Public route (not behind `authenticate`) — `req.user` is unset at
 * runtime here, so this handler must not read it.
 */
export async function getUserReviews(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await listReceivedReviews(req.params.id));
  } catch (err) {
    next(err);
  }
}
