import prisma from '../lib/prisma';
import { MINUTE_MS, kstDateString, nextKstTimeOfDay } from '../lib/time';
import type { PrismaTransactionClient } from '../types/index';
import { enqueueJob } from './queue';
import type { JobType } from './types';

/**
 * A job that repeats on a schedule. Each slot gets its own `dedupeKey`, so enqueueing the same
 * slot twice is a no-op and every function here is safe to call repeatedly.
 */
export interface RecurringJob {
  type: JobType;
  /** The first slot strictly after `now`. */
  nextRunAt(now: Date): Date;
  dedupeKey(runAt: Date): string;
}

const SWEEP_INTERVAL_MS = 10 * MINUTE_MS;

export const RECURRING_JOBS: readonly RecurringJob[] = [
  {
    type: 'project.lifecycleSweep',
    nextRunAt: (now) => new Date((Math.floor(now.getTime() / SWEEP_INTERVAL_MS) + 1) * SWEEP_INTERVAL_MS),
    dedupeKey: (runAt) => `project.lifecycleSweep:${runAt.toISOString()}`,
  },
  {
    type: 'maintenance.cleanup',
    nextRunAt: (now) => nextKstTimeOfDay(now, 4),
    dedupeKey: (runAt) => `maintenance.cleanup:${kstDateString(runAt)}`,
  },
];

export function findRecurringJob(type: string): RecurringJob | undefined {
  return RECURRING_JOBS.find((job) => job.type === type);
}

/** Enqueues the slot of `job` that follows `now`. */
export async function enqueueNextOccurrence(
  job: RecurringJob,
  now: Date,
  client: PrismaTransactionClient = prisma,
): Promise<boolean> {
  const runAt = job.nextRunAt(now);
  return enqueueJob(client, { type: job.type, runAt, dedupeKey: job.dedupeKey(runAt) });
}

/**
 * Makes sure every recurring type has its next slot queued. Called by every production-style
 * runner (dev worker at start, `jobs:run`, the internal endpoint) — but **not** by
 * `runDueJobs`, so tests only get recurring rows when they ask for them.
 *
 * Returns how many slots were newly enqueued.
 */
export async function ensureRecurringJobs(
  now: Date = new Date(),
  client: PrismaTransactionClient = prisma,
): Promise<number> {
  let created = 0;
  for (const job of RECURRING_JOBS) {
    if (await enqueueNextOccurrence(job, now, client)) created += 1;
  }
  return created;
}
