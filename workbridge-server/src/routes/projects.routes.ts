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
import { authenticate, requireRole } from '../middlewares/auth';
import { requireCompleteProfile } from '../middlewares/profile';
import { rateLimit } from '../middlewares/rateLimit';
import { ANALYZE_DAILY_RULE, ANALYZE_HOURLY_RULE } from '../lib/rateLimitRules';

const router = Router();

router.get('/', getProjects);
router.post('/', authenticate, requireRole('CLIENT'), requireCompleteProfile, createProject);
router.get('/:id/bookmark', authenticate, requireRole('FREELANCER'), getProjectBookmark);
router.post('/:id/bookmark', authenticate, requireRole('FREELANCER'), createProjectBookmark);
router.delete('/:id/bookmark', authenticate, requireRole('FREELANCER'), deleteProjectBookmark);
router.get('/:id', getProjectById);
router.patch('/:id', authenticate, requireRole('CLIENT'), updateProject);
router.delete('/:id', authenticate, requireRole('CLIENT'), deleteProject);
router.patch('/:id/status', authenticate, requireRole('CLIENT'), updateProjectStatus);
// Limited before the project lookup: the OpenAI cost is per request, so 404/403/502 count too.
router.post(
  '/:id/analyze',
  authenticate,
  requireRole('CLIENT'),
  rateLimit(ANALYZE_HOURLY_RULE),
  rateLimit(ANALYZE_DAILY_RULE),
  analyzeProject,
);

export default router;
