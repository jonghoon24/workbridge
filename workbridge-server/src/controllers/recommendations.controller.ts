import type { NextFunction, Response } from 'express';

import { recommendProjects } from '../lib/recommendations';
import type { RecommendationQuery } from '../schemas/profile';
import type { AuthedRequest } from '../types/index';

/** Project recommendations (docs/domain/projects-contracts.md). Read-only: no lifecycle sweep. */

/** `GET /api/users/me/recommended-projects`. */
export async function getRecommendedProjects(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as RecommendationQuery;
    res.json(await recommendProjects(req.user.id, limit));
  } catch (err) {
    next(err);
  }
}
