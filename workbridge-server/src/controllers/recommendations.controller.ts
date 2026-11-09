import type { NextFunction, Response } from 'express';

import { recommendFreelancers, recommendProjects } from '../lib/recommendations';
import type { RecommendationQuery } from '../schemas/profile';
import type { AuthedRequest } from '../types/index';

/** Recommendations (docs/domain/projects-contracts.md). Both are read-only: no lifecycle sweep. */

/** `GET /api/projects/:id/recommended-freelancers`. */
export async function getRecommendedFreelancers(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as RecommendationQuery;
    res.json(await recommendFreelancers(req.params.id, req.user.id, limit));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/me/recommended-projects`. */
export async function getRecommendedProjects(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as RecommendationQuery;
    res.json(await recommendProjects(req.user.id, limit));
  } catch (err) {
    next(err);
  }
}
