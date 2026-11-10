import { Router } from 'express';

import {
  approve,
  createSubmission,
  createSubmissionUploads,
  getMilestone,
  getSubmissionAttachment,
  reject,
} from '../controllers/milestones.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { validate } from '../middlewares/validate';
import { uploadRequestBody } from '../schemas/attachments';
import { rejectBody, submissionBody } from '../schemas/milestones';

/** `/api/milestones` — every route mounts `authenticate` → `requireActiveUser`, then the role where one applies. */
const router = Router();

router.get('/:id', authenticate, requireActiveUser, getMilestone);
router.get('/:id/attachments/:attachmentId/download', authenticate, requireActiveUser, getSubmissionAttachment);
// Files go straight to storage: this issues the signed upload URLs, the submission names the uploads.
router.post(
  '/:id/uploads',
  authenticate,
  requireActiveUser,
  requireRole('FREELANCER'),
  validate({ body: uploadRequestBody }),
  createSubmissionUploads,
);
router.post(
  '/:id/submissions',
  authenticate,
  requireActiveUser,
  requireRole('FREELANCER'),
  validate({ body: submissionBody }),
  createSubmission,
);
router.post('/:id/approve', authenticate, requireActiveUser, requireRole('CLIENT'), approve);
router.post('/:id/reject', authenticate, requireActiveUser, requireRole('CLIENT'), validate({ body: rejectBody }), reject);

export default router;
