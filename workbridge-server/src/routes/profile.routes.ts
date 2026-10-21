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
 * Portfolio, careers, profile completion and project recommendations (BEHAVIOR.md
 * "Portfolio and careers", "Profile completion and recommendations"). Mounted on `/api/users`
 * **after** `userRoutes`, so the existing `/me/*` and `/:id` routes keep precedence.
 * Register `PUT /me/portfolio/order` before `/me/portfolio/:itemId` (PF12). The public
 * `GET /:id/portfolio` and `GET /:id/careers` must not read `req.user`; with the id `me` they are
 * a 404 like any unknown user (PF19).
 * `GET /api/projects/:id/recommended-freelancers` (RC3) lives on the projects router instead.
 *
 * Attach guards per route, never with `router.use` — Q10 vectors and public GETs live here
 * (an unmatched path must still fall through to the HTML 404, and PF16/PF17 need no token).
 */
const router = Router();

const freelancer = [authenticate, requireActiveUser, requireRole('FREELANCER')];

// Public reads (PF16, PF17).
router.get('/:id/portfolio', getUserPortfolio);
router.get('/:id/careers', getUserCareers);

// Portfolio writes (PF9–PF12). The upload runs after the role check and before validation
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

// Career writes (PF13–PF15), JSON only.
router.post('/me/careers', ...freelancer, validate({ body: careerCreateBody }), postCareer);
router.patch('/me/careers/:careerId', ...freelancer, validate({ body: careerPatchBody }), patchCareer);
router.delete('/me/careers/:careerId', ...freelancer, removeCareer);

// PF21 — either role.
router.get('/me/profile-completion', authenticate, requireActiveUser, getMyProfileCompletion);

// RC6 — role, then complete profile (rule 4), then validation.
router.get(
  '/me/recommended-projects',
  ...freelancer,
  requireCompleteProfile,
  validate({ query: recommendationQuery }),
  getRecommendedProjects,
);

export default router;
