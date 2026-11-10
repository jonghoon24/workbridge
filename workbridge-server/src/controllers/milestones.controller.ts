import type { NextFunction, Response } from 'express';

import {
  approveMilestone,
  getMilestoneDetail,
  getSubmissionAttachmentDownload,
  listContractMilestones,
  rejectMilestone,
  replacePlan,
  requestSubmissionUploads,
  submitMilestone,
} from '../services/milestones.service';
import type { PlanItem, SubmissionInput } from '../services/milestones.service';
import type { RequestedFile } from '../services/attachments.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/contracts/:id/milestones`. */
export async function getContractMilestones(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listContractMilestones(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PUT /api/contracts/:id/milestones`. */
export async function putContractMilestones(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { milestones } = req.body as { milestones: PlanItem[] };
    res.json(await replacePlan(req.params.id, req.user.id, milestones));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/milestones/:id`. */
export async function getMilestone(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getMilestoneDetail(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/milestones/:id/uploads`. */
export async function createSubmissionUploads(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { files } = req.body as { files: RequestedFile[] };
    res.status(201).json(await requestSubmissionUploads(req.params.id, req.user.id, files, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/milestones/:id/submissions`. */
export async function createSubmission(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const result = await submitMilestone(req.params.id, req.user.id, req.body as SubmissionInput, new Date());
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/** `GET /api/milestones/:id/attachments/:attachmentId/download`. */
export async function getSubmissionAttachment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getSubmissionAttachmentDownload(req.params.id, req.params.attachmentId, req.user.id, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/milestones/:id/approve`. */
export async function approve(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const result = await approveMilestone(req.params.id, { kind: 'MANUAL', actorId: req.user.id, now: new Date() });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** `POST /api/milestones/:id/reject`. */
export async function reject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason: string };
    res.json(await rejectMilestone(req.params.id, { actorId: req.user.id, reason, now: new Date() }));
  } catch (err) {
    next(err);
  }
}
