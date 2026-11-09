import { Router } from 'express';
import {
  apply,
  getApplications,
  updateApplication,
} from '../controllers/applications.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireCompleteProfile } from '../middlewares/profile';
import { validate } from '../middlewares/validate';
import { applicationCreateBody, applicationDecisionBody } from '../schemas/applications';

const router = Router();

// Pre-existing routes: no `requireActiveUser` — 알려진 불일치 D12 (#7). Validation (rule 12) runs
// before the controller, so an invalid body is a 400 before the lifecycle sweep and the
// project lookup (Q15).
router.post(
  '/:id/applications',
  authenticate,
  requireRole('FREELANCER'),
  requireCompleteProfile,
  validate({ body: applicationCreateBody }),
  apply,
);
router.get('/:id/applications', authenticate, requireRole('CLIENT'), getApplications);
router.patch(
  '/:projectId/applications/:appId',
  authenticate,
  requireRole('CLIENT'),
  validate({ body: applicationDecisionBody }),
  updateApplication,
);

export default router;
