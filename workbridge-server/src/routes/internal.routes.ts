import { Router } from 'express';

import { runJobs } from '../controllers/internal.controller';
import { requireInternalToken } from '../middlewares/internalToken';
import { validate } from '../middlewares/validate';
import { runJobsBody } from '../schemas/internal';

const router = Router();

// Token first, validation second: an unauthenticated caller learns nothing from a 400.
router.post('/jobs/run', requireInternalToken, validate({ body: runJobsBody }), runJobs);

export default router;
