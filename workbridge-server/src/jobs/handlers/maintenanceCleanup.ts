import prisma from '../../lib/prisma';
import { sqlTimestamp } from '../../lib/sql';
import { DAY_MS } from '../../lib/time';
import { enqueueJob } from '../queue';
import type { JobHandler } from '../types';

export const JOB_RETENTION_DAYS = 14;
/** Expired uploads per `attachment.deleteObjects` job. */
export const UPLOAD_SWEEP_BATCH = 500;

/**
 * `maintenance.cleanup` — daily at 04:00 KST. Drops finished jobs older than the retention
 * period and expired rate-limit counters. `FAILED` jobs are kept so someone can inspect them.
 * Expired attachment uploads that nothing claimed are deleted with an `attachment.deleteObjects`
 * job for their files, in one transaction per batch.
 */
export const maintenanceCleanup: JobHandler<'maintenance.cleanup'> = async ({ now, logger }) => {
  const cutoff = new Date(now.getTime() - JOB_RETENTION_DAYS * DAY_MS);

  const jobs = await prisma.job.deleteMany({
    where: { status: { in: ['SUCCEEDED', 'CANCELLED'] }, updatedAt: { lt: cutoff } },
  });
  const counters = await prisma.rateLimitCounter.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  let expiredUploads = 0;
  for (;;) {
    const swept = await prisma.$transaction(async (tx) => {
      // Only the rows this statement deleted: a row a concurrent claim consumed first is attached
      // now, and its file must stay.
      const deleted = await tx.$queryRaw<{ storageKey: string }[]>`
        DELETE FROM "AttachmentUpload"
         WHERE "id" IN (
           SELECT "id" FROM "AttachmentUpload" WHERE "expiresAt" <= ${sqlTimestamp(now)}
            ORDER BY "expiresAt" LIMIT ${UPLOAD_SWEEP_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING "storageKey"`;
      if (deleted.length === 0) return 0;
      await enqueueJob(tx, {
        type: 'attachment.deleteObjects',
        payload: { keys: deleted.map((u) => u.storageKey) },
        runAt: now,
      });
      return deleted.length;
    });
    expiredUploads += swept;
    if (swept < UPLOAD_SWEEP_BATCH) break;
  }

  logger.info('maintenance cleanup', {
    deletedJobs: jobs.count,
    deletedRateLimitCounters: counters.count,
    expiredUploads,
  });
};
