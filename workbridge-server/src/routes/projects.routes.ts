import { Router } from 'express';
import {
  getProjects,
  createProject,
  getProjectById,
  getProjectBookmark,
  createProjectBookmark,
  deleteProjectBookmark,
  updateProject,
  deleteProject,
  updateProjectStatus,
  analyzeProject,
} from '../controllers/projects.controller';
import { getRecommendedFreelancers } from '../controllers/recommendations.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { requireCompleteProfile } from '../middlewares/profile';
import { rateLimit } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { ANALYZE_DAILY_RULE, ANALYZE_HOURLY_RULE } from '../lib/rateLimitRules';
import { recommendationQuery } from '../schemas/profile';
import { projectCreateBody, projectListQuery, projectStatusBody, projectUpdateBody } from '../schemas/projects';

const router = Router();

// `authenticate` only: these routes do not mount `requireActiveUser` yet (#7).
// Validation runs after the role and profile guards and before the controller's
// 404/403 checks.
router.get('/', validate({ query: projectListQuery }), getProjects);
router.post(
  '/',
  authenticate,
  requireRole('CLIENT'),
  requireCompleteProfile,
  validate({ body: projectCreateBody }),
  createProject,
);
router.get('/:id/bookmark', authenticate, requireRole('FREELANCER'), getProjectBookmark);
router.post('/:id/bookmark', authenticate, requireRole('FREELANCER'), createProjectBookmark);
router.delete('/:id/bookmark', authenticate, requireRole('FREELANCER'), deleteProjectBookmark);
router.get('/:id', getProjectById);
router.patch('/:id', authenticate, requireRole('CLIENT'), validate({ body: projectUpdateBody }), updateProject);
router.delete('/:id', authenticate, requireRole('CLIENT'), deleteProject);
router.patch(
  '/:id/status',
  authenticate,
  requireRole('CLIENT'),
  validate({ body: projectStatusBody }),
  updateProjectStatus,
);
// Limited before the project lookup: the OpenAI cost is per request, so 404/403/502 count too.
// The route takes no body or query, so there is nothing to validate.
router.post(
  '/:id/analyze',
  authenticate,
  requireRole('CLIENT'),
  rateLimit(ANALYZE_HOURLY_RULE),
  rateLimit(ANALYZE_DAILY_RULE),
  analyzeProject,
);

// Freelancers recommended for the caller's project. Read-only —
// unlike `GET /:id`, it runs no lifecycle sweep.
router.get(
  '/:id/recommended-freelancers',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  validate({ query: recommendationQuery }),
  getRecommendedFreelancers,
);

export default router;
