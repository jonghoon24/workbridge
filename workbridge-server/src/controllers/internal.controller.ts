import type { NextFunction, Request, Response } from 'express';

import { ensureRecurringJobs } from '../jobs/recurring';
import { recoverStaleJobs, runDueJobs } from '../jobs/runner';
import type { RunJobsBody } from '../schemas/internal';

/**
 * `POST /api/internal/jobs/run` — one pass of the job queue for an external scheduler.
 *
 * Public in the JWT sense (guarded by `requireInternalToken`, not `authenticate`), so it must
 * **never read `req.user`**.
 */
export async function runJobs(req: Request, res: Response, next: NextFunction) {
  try {
    const { limit } = req.body as RunJobsBody;
    const now = new Date();

    await ensureRecurringJobs(now);
    await recoverStaleJobs(now);
    const result = await runDueJobs({ now, limit });

    res.json(result);
  } catch (err) {
    next(err);
  }
}
