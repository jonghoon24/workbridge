import type { Job } from '@prisma/client';

import { runDueJobs } from '../../src/jobs/runner';
import type { RunDueJobsResult } from '../../src/jobs/runner';
import type { JobType } from '../../src/jobs/types';
import { prisma } from './db';

/**
 * Runs every job due at `now`, exactly as a runner would. Tests drive time by passing `now`
 * rather than using fake timers, which do not mix well with Prisma.
 */
export function runJobs(now: Date = new Date()): Promise<RunDueJobsResult> {
  return runDueJobs({ now });
}

/** Every job of `type`, oldest `runAt` first. */
export function jobsOf(type: JobType): Promise<Job[]> {
  return prisma.job.findMany({ where: { type }, orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }] });
}

/** An instant `days` days from the real now (fractions allowed). */
export function atDaysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}
