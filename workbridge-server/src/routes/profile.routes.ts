import { Router } from 'express';

import {
  getMyProfileCompletion,
  getUserCareers,
  getUserPortfolio,
  patchCareer,
  patchPortfolioItem,
  postCareer,
  postPortfolioItem,
  putPortfolioOrder,
  removeCareer,
  removePortfolioItem,
} from '../controllers/profile.controller';
import { getRecommendedProjects } from '../controllers/recommendations.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { imageUpload } from '../middlewares/attachmentUpload';
import { requireCompleteProfile } from '../middlewares/profile';
import { validate } from '../middlewares/validate';
import {
  careerCreateBody,
  careerPatchBody,
  portfolioCreateBody,
  portfolioOrderBody,
  portfolioPatchBody,
  recommendationQuery,
} from '../schemas/profile';

/**
 * Portfolio, careers, profile completion and project recommendations. Mounted on `/api/users`
 * **after** `userRoutes`, so the `/me/*` and `/:id` routes there keep precedence.
 * Register `PUT /me/portfolio/order` before `/me/portfolio/:itemId`, or `order` would match
 * `:itemId`. The public `GET /:id/portfolio` and `GET /:id/careers` must not read `req.user`;
 * there is no `/me/portfolio` or `/me/careers` read, so with the id `me` they are a 404 like any
 * unknown user.
 * `GET /api/projects/:id/recommended-freelancers` lives on the projects router instead.
 *
 * Attach guards per route, never with `router.use` — unmatched paths and public GETs pass through
 * here (an unmatched path must still fall through to Express's HTML 404, #19, and the public
 * reads need no token).
 */
const router = Router();

const freelancer = [authenticate, requireActiveUser, requireRole('FREELANCER')];

// Public reads.
router.get('/:id/portfolio', getUserPortfolio);
router.get('/:id/careers', getUserCareers);

// Portfolio writes. The upload runs after the role check and before validation
// (multer fills `req.body`); it passes a JSON request through untouched.
router.post('/me/portfolio', ...freelancer, imageUpload, validate({ body: portfolioCreateBody }), postPortfolioItem);
router.put('/me/portfolio/order', ...freelancer, validate({ body: portfolioOrderBody }), putPortfolioOrder);
router.patch(
  '/me/portfolio/:itemId',
  ...freelancer,
  imageUpload,
  validate({ body: portfolioPatchBody }),
  patchPortfolioItem,
);
router.delete('/me/portfolio/:itemId', ...freelancer, removePortfolioItem);

// Career writes, JSON only.
router.post('/me/careers', ...freelancer, validate({ body: careerCreateBody }), postCareer);
router.patch('/me/careers/:careerId', ...freelancer, validate({ body: careerPatchBody }), patchCareer);
router.delete('/me/careers/:careerId', ...freelancer, removeCareer);

// Profile completion — either role.
router.get('/me/profile-completion', authenticate, requireActiveUser, getMyProfileCompletion);

// Recommended projects — role, then complete profile, then validation.
router.get(
  '/me/recommended-projects',
  ...freelancer,
  requireCompleteProfile,
  validate({ query: recommendationQuery }),
  getRecommendedProjects,
);

export default router;
