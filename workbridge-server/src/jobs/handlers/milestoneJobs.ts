import { PermanentJobError } from '../errors';
import {
  approveMilestone,
  findMilestoneForJob,
  latestRound,
  sendMilestoneNotice,
} from '../../services/milestones.service';
import type { JobHandler } from '../types';

/**
 * Milestone jobs (BEHAVIOR.md J1–J5). Each re-reads the milestone and ends as a successful
 * no-op when its moment has passed; a payload naming a missing milestone is permanent (J1).
 */

async function load(milestoneId: string) {
  const milestone = await findMilestoneForJob(milestoneId);
  if (!milestone) throw new PermanentJobError(`milestone ${milestoneId} does not exist`);
  return milestone;
}

/** J2: approves regardless of project deletion (MS17's deleted-project case). */
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

/** J3. */
export const milestoneAutoApproveReminder: JobHandler<'milestone.autoApproveReminder'> = async ({ payload, now }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt) return;
  if (milestone.status !== 'SUBMITTED') return;
  if ((await latestRound(milestone.id)) !== payload.round) return;
  if (!milestone.autoApproveAt || milestone.autoApproveAt <= now) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_AUTO_APPROVE_REMINDER');
};

const IN_PROGRESS = new Set(['FUNDED', 'REVISION_REQUESTED']);

/** J4. */
export const milestoneDueSoon: JobHandler<'milestone.dueSoon'> = async ({ payload }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt || !IN_PROGRESS.has(milestone.status)) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_DUE_SOON');
};

/** J5. */
export const milestoneOverdue: JobHandler<'milestone.overdue'> = async ({ payload }) => {
  const milestone = await load(payload.milestoneId);
  if (milestone.contract.project.deletedAt || !IN_PROGRESS.has(milestone.status)) return;
  await sendMilestoneNotice(milestone, 'MILESTONE_OVERDUE');
};
