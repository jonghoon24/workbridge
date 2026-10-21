import type { Job } from '@prisma/client';

import type { Logger } from '../lib/logger';

/**
 * Every job type, with its payload shape. `Job.type` is a bare `String` in the schema (like
 * `Notification.type`), so adding a type needs no migration — add it here, give it a handler
 * in `registry.ts`, and document it in BEHAVIOR.md "Background jobs".
 */
export interface JobPayloads {
  'project.lifecycleSweep': Record<string, never>;
  'maintenance.cleanup': Record<string, never>;
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
