import { Router } from 'express';
import {
  apply,
  getApplications,
  updateApplication,
} from '../controllers/applications.controller.js';
import { authenticate, requireRole } from '../middlewares/auth.js';

const router = Router();

router.post('/:id/applications', authenticate, requireRole('FREELANCER'), apply);
router.get('/:id/applications', authenticate, requireRole('CLIENT'), getApplications);
router.patch('/:projectId/applications/:appId', authenticate, requireRole('CLIENT'), updateApplication);

export default router;
