import { PermanentJobError } from '../errors';
import {
  approveMilestone,
  findMilestoneForJob,
  latestRound,
  sendMilestoneNotice,
} from '../../services/milestones.service';
import type { JobHandler } from '../types';

/**
 * Milestone jobs (docs/domain/milestones-payments.md "자동 승인과 기한 알림"). Each re-reads the
 * milestone and ends as a successful no-op when its moment has passed; a payload naming a missing
 * milestone is permanent.
 */

async function load(milestoneId: string) {
  const milestone = await findMilestoneForJob(milestoneId);
  if (!milestone) throw new PermanentJobError(`milestone ${milestoneId} does not exist`);
  return milestone;
}

/** Approves regardless of project deletion: money already paid is never held by a deletion. */
export const milestoneAutoApprove: JobHandler<'milestone.autoApprove'> = async ({ payload, now, logger }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.status !== 'SUBMITTED') return;
  if ((await latestRound(milestone.id)) !== payload.round) return;
  if (!milestone.autoApproveAt || milestone.autoApproveAt > now) return;

  const result = await approveMilestone(milestone.id, { kind: 'AUTO', actorId: null, now });
  if (result) {
    logger.info('milestone auto-approved', { milestoneId: milestone.id, contractStatus: result.contract.status });
  }
};

/** Tells the client that the submission is about to be approved automatically. */
export const milestoneAutoApproveReminder: JobHandler<'milestone.autoApproveReminder'> = async ({ payload, now }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt) return;
  if (milestone.status !== 'SUBMITTED') return;
  if ((await latestRound(milestone.id)) !== payload.round) return;
  if (!milestone.autoApproveAt || milestone.autoApproveAt <= now) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_AUTO_APPROVE_REMINDER', now);
};

const IN_PROGRESS = new Set(['FUNDED', 'REVISION_REQUESTED']);

/** Tells the freelancer that the due date is near. */
export const milestoneDueSoon: JobHandler<'milestone.dueSoon'> = async ({ payload, now }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt || !IN_PROGRESS.has(milestone.status)) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_DUE_SOON', now);
};

/** Tells both parties that the due date has passed. */
export const milestoneOverdue: JobHandler<'milestone.overdue'> = async ({ payload, now }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt || !IN_PROGRESS.has(milestone.status)) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_OVERDUE', now);
};
