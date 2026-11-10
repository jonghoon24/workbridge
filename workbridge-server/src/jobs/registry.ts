import { maintenanceCleanup } from './handlers/maintenanceCleanup';
import { projectLifecycleSweep } from './handlers/projectLifecycleSweep';
import {
  milestoneAutoApprove,
  milestoneAutoApproveReminder,
  milestoneDueSoon,
  milestoneOverdue,
} from './handlers/milestoneJobs';
import { settlementPayout, settlementWeeklyBatch } from './handlers/settlementJobs';
import { messageUnreadDigest } from './handlers/messageDigest';
import { notificationEmail } from './handlers/notificationEmail';
import { attachmentDeleteObjects } from './handlers/attachmentJobs';
import type { JobHandler, JobType } from './types';

/** One handler per job type. The mapped type makes a missing handler a compile error. */
export const registry: { [T in JobType]: JobHandler<T> } = {
  'project.lifecycleSweep': projectLifecycleSweep,
  'maintenance.cleanup': maintenanceCleanup,
  'milestone.autoApprove': milestoneAutoApprove,
  'milestone.autoApproveReminder': milestoneAutoApproveReminder,
  'milestone.dueSoon': milestoneDueSoon,
  'milestone.overdue': milestoneOverdue,
  'settlement.weeklyBatch': settlementWeeklyBatch,
  'settlement.payout': settlementPayout,
  'message.unreadDigest': messageUnreadDigest,
  'notification.email': notificationEmail,
  'attachment.deleteObjects': attachmentDeleteObjects,
};

export function handlerFor(type: string): JobHandler | undefined {
  return Object.prototype.hasOwnProperty.call(registry, type)
    ? (registry[type as JobType] as JobHandler)
    : undefined;
}
