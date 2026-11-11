import type { NextFunction, Response } from 'express';

import { decideApplication, listProjectApplications, submitApplication } from '../services/applications.service';
import type { ApplicationCreateInput, ApplicationDecisionInput } from '../schemas/applications';
import type { AuthedRequest } from '../types/index';

/** `POST /api/projects/:id/applications`. The body was parsed by `applicationCreateBody`. */
export async function apply(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const application = await submitApplication(
      req.params.id,
      req.user.id,
      req.body as ApplicationCreateInput,
      new Date(),
    );
    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
}

/** `GET /api/projects/:id/applications`. Rejects a closed project's stale pending applications, so it writes rows. */
export async function getApplications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listProjectApplications(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/projects/:projectId/applications/:appId`. The body was parsed by `applicationDecisionBody`. */
export async function updateApplication(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { projectId, appId } = req.params;
    res.json(await decideApplication(projectId, appId, req.user.id, req.body as ApplicationDecisionInput, new Date()));
  } catch (err) {
    next(err);
  }
}
