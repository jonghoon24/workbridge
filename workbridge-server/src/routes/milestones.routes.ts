import { Router } from 'express';

import { approve, createSubmission, getMilestone, reject } from '../controllers/milestones.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { attachmentUpload } from '../middlewares/attachmentUpload';
import { validate } from '../middlewares/validate';
import { rejectBody, submissionBody } from '../schemas/milestones';

/** `/api/milestones` — expansion routes (BEHAVIOR.md rule 12, MS5). */
const router = Router();

router.get('/:id', authenticate, requireActiveUser, getMilestone);
// The upload runs after the role check and before validation (multer fills `req.body`).
router.post(
  '/:id/submissions',
  authenticate,
  requireActiveUser,
  requireRole('FREELANCER'),
  attachmentUpload,
  validate({ body: submissionBody }),
  createSubmission,
);
router.post('/:id/approve', authenticate, requireActiveUser, requireRole('CLIENT'), approve);
router.post('/:id/reject', authenticate, requireActiveUser, requireRole('CLIENT'), validate({ body: rejectBody }), reject);

export default router;
