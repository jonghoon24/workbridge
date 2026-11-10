import { Router } from 'express';
import {
  apply,
  getApplications,
  updateApplication,
} from '../controllers/applications.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { requireCompleteProfile } from '../middlewares/profile';
import { validate } from '../middlewares/validate';
import { applicationCreateBody, applicationDecisionBody } from '../schemas/applications';

const router = Router();

// The writes mount `requireActiveUser`. Validation runs before the controller, so an invalid
// body is a 400 before the lifecycle sweep and the project lookup.
router.post(
  '/:id/applications',
  authenticate,
  requireActiveUser,
  requireRole('FREELANCER'),
  requireCompleteProfile,
  validate({ body: applicationCreateBody }),
  apply,
);
router.get('/:id/applications', authenticate, requireRole('CLIENT'), getApplications);
router.patch(
  '/:projectId/applications/:appId',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  validate({ body: applicationDecisionBody }),
  updateApplication,
);

export default router;
