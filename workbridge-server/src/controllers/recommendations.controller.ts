import type { NextFunction, Response } from 'express';

import { recommendFreelancers, recommendProjects } from '../lib/recommendations';
import type { RecommendationQuery } from '../schemas/profile';
import type { AuthedRequest } from '../types/index';

/** BEHAVIOR.md "Recommendations" (RC1–RC8). Both are read-only: no lifecycle sweep. */

/** `GET /api/projects/:id/recommended-freelancers` (RC3–RC5). */
export async function getRecommendedFreelancers(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as RecommendationQuery;
    res.json(await recommendFreelancers(req.params.id, req.user.id, limit));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/me/recommended-projects` (RC6–RC8). */
export async function getRecommendedProjects(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as RecommendationQuery;
    res.json(await recommendProjects(req.user.id, limit));
  } catch (err) {
    next(err);
  }
}
