import { Router } from 'express';
import {
  apply,
  getApplications,
  updateApplication,
} from '../controllers/applications.controller.js';
import { authenticate, requireRole } from '../middlewares/auth.js';
import { requireCompleteProfile } from '../middlewares/profile.js';

const router = Router();

router.post('/:id/applications', authenticate, requireRole('FREELANCER'), requireCompleteProfile, apply);
router.get('/:id/applications', authenticate, requireRole('CLIENT'), getApplications);
router.patch('/:projectId/applications/:appId', authenticate, requireRole('CLIENT'), updateApplication);

export default router;
