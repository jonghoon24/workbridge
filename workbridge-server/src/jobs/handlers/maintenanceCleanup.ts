import prisma from '../../lib/prisma';
import { DAY_MS } from '../../lib/time';
import type { JobHandler } from '../types';

export const JOB_RETENTION_DAYS = 14;

/**
 * `maintenance.cleanup` — daily at 04:00 KST. Drops finished jobs older than the retention
 * period and expired rate-limit counters. `FAILED` jobs are kept so someone can inspect them.
 */
export const maintenanceCleanup: JobHandler<'maintenance.cleanup'> = async ({ now, logger }) => {
  const cutoff = new Date(now.getTime() - JOB_RETENTION_DAYS * DAY_MS);

  const jobs = await prisma.job.deleteMany({
    where: { status: { in: ['SUCCEEDED', 'CANCELLED'] }, updatedAt: { lt: cutoff } },
  });
  const counters = await prisma.rateLimitCounter.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  logger.info('maintenance cleanup', { deletedJobs: jobs.count, deletedRateLimitCounters: counters.count });
};
