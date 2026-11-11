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
} from '../controllers/projects.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { requireCompleteProfile } from '../middlewares/profile';
import { validate } from '../middlewares/validate';
import { projectCreateBody, projectListQuery, projectStatusBody, projectUpdateBody } from '../schemas/projects';

const router = Router();

// Every write mounts `requireActiveUser` after `authenticate`, so a soft-deleted caller's
// unexpired token cannot write. Validation runs after the role and profile guards and before
// the controller's 404/403 checks.
router.get('/', validate({ query: projectListQuery }), getProjects);
router.post(
  '/',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  requireCompleteProfile,
  validate({ body: projectCreateBody }),
  createProject,
);
router.get('/:id/bookmark', authenticate, requireRole('FREELANCER'), getProjectBookmark);
router.post('/:id/bookmark', authenticate, requireActiveUser, requireRole('FREELANCER'), createProjectBookmark);
router.delete('/:id/bookmark', authenticate, requireActiveUser, requireRole('FREELANCER'), deleteProjectBookmark);
router.get('/:id', getProjectById);
router.patch(
  '/:id',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  validate({ body: projectUpdateBody }),
  updateProject,
);
router.delete('/:id', authenticate, requireActiveUser, requireRole('CLIENT'), deleteProject);
router.patch(
  '/:id/status',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  validate({ body: projectStatusBody }),
  updateProjectStatus,
);

export default router;
