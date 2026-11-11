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
import { getMyBookmarkedProjectIds } from '../controllers/bookmarks.controller';
import { getWithdrawal, postWithdrawal } from '../controllers/account.controller';
import { getRecommendedProjects } from '../controllers/recommendations.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { imageUpload } from '../middlewares/attachmentUpload';
import { requireCompleteProfile } from '../middlewares/profile';
import { rateLimit } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { PASSWORD_CONFIRM_FAILURE_RULE } from '../lib/rateLimitRules';
import { withdrawalBody } from '../schemas/account';
import {
  careerCreateBody,
  careerPatchBody,
  portfolioCreateBody,
  portfolioOrderBody,
  portfolioPatchBody,
  recommendationQuery,
} from '../schemas/profile';

/**
 * Portfolio, careers, profile completion, project recommendations and withdrawal. Mounted on `/api/users`
 * **after** `userRoutes`, so the `/me/*` and `/:id` routes there keep precedence.
 * Register `PUT /me/portfolio/order` before `/me/portfolio/:itemId`, or `order` would match
 * `:itemId`. The public `GET /:id/portfolio` and `GET /:id/careers` must not read `req.user`;
 * there is no `/me/portfolio` or `/me/careers` read, so with the id `me` they are a 404 like any
 * unknown user.
 *
 * Attach guards per route, never with `router.use` — unmatched paths and public GETs pass through
 * here (an unmatched path must still fall through to the final JSON 404 rather than a guard's 401,
 * and the public reads need no token).
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

// The caller's bookmarked project ids, so a project list marks its cards in one request. It takes
// no query, so there is nothing to validate.
router.get('/me/bookmarks/ids', ...freelancer, getMyBookmarkedProjectIds);

// Withdrawal — either role. The status read, then the withdrawal itself, whose password check
// shares the change-password failure limit (the middleware only peeks; the service counts).
router.get('/me/withdrawal', authenticate, requireActiveUser, getWithdrawal);
router.post(
  '/me/withdrawal',
  authenticate,
  requireActiveUser,
  rateLimit(PASSWORD_CONFIRM_FAILURE_RULE, { mode: 'peek' }),
  validate({ body: withdrawalBody }),
  postWithdrawal,
);

// Recommended projects — role, then complete profile, then validation.
router.get(
  '/me/recommended-projects',
  ...freelancer,
  requireCompleteProfile,
  validate({ query: recommendationQuery }),
  getRecommendedProjects,
);

export default router;
