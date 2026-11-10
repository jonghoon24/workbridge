import type { Job } from '@prisma/client';

import type { Logger } from '../lib/logger';

/**
 * Every job type, with its payload shape. `Job.type` is a bare `String` in the schema (like
 * `Notification.type`), so adding a type needs no migration — add it here, give it a handler
 * in `registry.ts`, and document it in docs/domain/jobs.md.
 */
export interface JobPayloads {
  'project.lifecycleSweep': Record<string, never>;
  'maintenance.cleanup': Record<string, never>;
  // Milestones and settlements
  'milestone.autoApprove': { milestoneId: string; round: number };
  'milestone.autoApproveReminder': { milestoneId: string; round: number };
  'milestone.dueSoon': { milestoneId: string };
  'milestone.overdue': { milestoneId: string };
  /** Recurring; the settled period is read from the job's `dedupeKey`, never from `runAt`. */
  'settlement.weeklyBatch': Record<string, never>;
  /** `scheduledPayoutAt` is an ISO-8601 string; a mismatch with the row means "rescheduled". */
  'settlement.payout': { settlementId: string; scheduledPayoutAt: string };
  // Messaging. No dedupeKey: the enqueue rule matches PENDING jobs on the payload.
  'message.unreadDigest': { conversationId: string; recipientId: string };
  // Notification channels. dedupeKey `notification.email:<deliveryId>`, enqueued by notify().
  'notification.email': { deliveryId: string };
  // Attachments. Keys in the private attachment bucket; a key already gone is not an error.
  'attachment.deleteObjects': { keys: string[] };
}

export type JobType = keyof JobPayloads;

export interface JobContext<T extends JobType = JobType> {
  job: Job;
  payload: JobPayloads[T];
  /** The runner's notion of "now". Handlers must use this, never `new Date()`. */
  now: Date;
  logger: Logger;
}

/**
 * A job handler. Must be **idempotent**: re-read the state it acts on and write conditionally
 * (`updateMany` with the expected status in `where`), because a job can run twice — for
 * example when stale-lock recovery hands a slow job to a second runner.
 */
export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<void>;
