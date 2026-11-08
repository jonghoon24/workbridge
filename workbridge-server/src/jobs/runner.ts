import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Job } from '@prisma/client';

import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { runWithContext } from '../lib/requestContext';
import { captureError, flushSentry } from '../lib/sentry';
import { HOUR_MS, MINUTE_MS } from '../lib/time';
import { sqlTimestamp } from '../lib/sql';
import { PermanentJobError } from './errors';
import { heldJobTypes } from './gates';
import { enqueueNextOccurrence, findRecurringJob } from './recurring';
import { handlerFor } from './registry';
import type { JobType } from './types';

/** A `RUNNING` job whose lock is older than this is assumed orphaned by a dead runner. */
export const STALE_LOCK_MS = 10 * MINUTE_MS;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = HOUR_MS;
const MAX_ERROR_LENGTH = 2000;
const STALE_EXHAUSTED_ERROR = 'stale lock, attempts exhausted';

/** Identifies this process in `Job.lockedBy`. */
export const WORKER_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

export interface RunDueJobsOptions {
  now?: Date;
  limit?: number;
  types?: readonly JobType[];
  workerId?: string;
}

export interface RunDueJobsResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  /** Claimed, but another runner had taken the lock over before this one got to it. */
  skipped: number;
}

/** `min(30 s × 2^(attempts − 1), 1 h)` — `attempts` already counts the run that just failed. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

/**
 * Atomically moves up to `limit` due `PENDING` jobs to `RUNNING`, except the held types of
 * `gates.ts`. `FOR UPDATE SKIP LOCKED`
 * makes concurrent runners skip each other's rows instead of blocking or double-claiming.
 */
async function claimDueJobs(now: Date, limit: number, workerId: string, types?: readonly JobType[]): Promise<Job[]> {
  const typeFilter = types && types.length > 0
    ? Prisma.sql`AND "type" IN (${Prisma.join([...types])})`
    : Prisma.empty;
  // Gated types stay PENDING until their flag is turned on (`gates.ts`).
  const held = heldJobTypes();
  const heldFilter = held.length > 0
    ? Prisma.sql`AND "type" NOT IN (${Prisma.join(held)})`
    : Prisma.empty;

  const claimed = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
       SET "status" = 'RUNNING', "lockedAt" = ${sqlTimestamp(now)}, "lockedBy" = ${workerId},
           "attempts" = "attempts" + 1, "updatedAt" = ${sqlTimestamp(now)}
     WHERE "id" IN (
       SELECT "id" FROM "Job"
        WHERE "status" = 'PENDING' AND "runAt" <= ${sqlTimestamp(now)} ${typeFilter} ${heldFilter}
        ORDER BY "runAt", "createdAt"
        LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
     )
    RETURNING *`;

  // `RETURNING` does not preserve the subquery's order.
  return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

type Outcome = 'succeeded' | 'retried' | 'failed' | 'skipped';

async function runOne(job: Job, now: Date, workerId: string): Promise<Outcome> {
  // Only touch the row while we still own it: stale-lock recovery may have handed it on.
  const owned = { id: job.id, status: 'RUNNING' as const, lockedBy: workerId };
  const unlock = { lockedAt: null, lockedBy: null };

  // Re-assert ownership before running. Jobs in a batch run one after another, so a long batch
  // can outlive the 10-minute stale-lock window; if another runner has recovered and taken this
  // job in the meantime, running it here too would run the handler twice.
  const { count: stillOwned } = await prisma.job.updateMany({ where: owned, data: { lockedBy: workerId } });
  if (stillOwned === 0) {
    logger.warn('job skipped: lock taken over', { jobId: job.id, type: job.type });
    return 'skipped';
  }

  // The next slot of a recurring job is enqueued at claim time, not on success, so one slot
  // that retries and finally fails does not break the chain. A failure here must not strand
  // the job (or the rest of the batch): log it, and let the next `ensureRecurringJobs` repair it.
  const recurring = findRecurringJob(job.type);
  if (recurring) {
    try {
      await enqueueNextOccurrence(recurring, now);
    } catch (err) {
      logger.warn('could not enqueue next recurring slot', { type: job.type, err });
    }
  }

  const handler = handlerFor(job.type);

  try {
    if (!handler) {
      throw new PermanentJobError(`No handler registered for job type "${job.type}"`);
    }

    await handler({ job, payload: job.payload as never, now, logger });

    await prisma.job.updateMany({
      where: owned,
      data: { status: 'SUCCEEDED', completedAt: now, ...unlock },
    });
    return 'succeeded';
  } catch (err) {
    const permanent = err instanceof PermanentJobError;
    const exhausted = job.attempts >= job.maxAttempts;

    if (permanent || exhausted) {
      await prisma.job.updateMany({
        where: owned,
        data: { status: 'FAILED', lastError: errorText(err), ...unlock },
      });
      logger.error('job failed', {
        type: job.type,
        attempts: job.attempts,
        reason: permanent ? 'permanent' : 'attempts exhausted',
        err,
      });
      // No-op without `SENTRY_DSN`; never throws. Sent by the flush at the end of `runDueJobs`.
      await captureError(err, {
        tags: { jobId: job.id, jobType: job.type, attempt: job.attempts, requestId: job.traceId ?? undefined },
        extra: { maxAttempts: job.maxAttempts, reason: permanent ? 'permanent' : 'attempts exhausted' },
      });
      return 'failed';
    }

    await prisma.job.updateMany({
      where: owned,
      data: {
        status: 'PENDING',
        runAt: new Date(now.getTime() + backoffMs(job.attempts)),
        lastError: errorText(err),
        ...unlock,
      },
    });
    logger.warn('job will retry', { type: job.type, attempts: job.attempts, err });
    return 'retried';
  }
}

/**
 * Claims and runs every job due at `now`, one after another. The single entry point shared by
 * tests, the CLI, the dev worker and the internal endpoint. Deliberately does **not** call
 * `ensureRecurringJobs` — the production-style callers do that first.
 */
export async function runDueJobs(options: RunDueJobsOptions = {}): Promise<RunDueJobsResult> {
  const { now = new Date(), limit = 50, types, workerId = WORKER_ID } = options;
  const jobs = await claimDueJobs(now, limit, workerId, types);
  const result: RunDueJobsResult = { claimed: jobs.length, succeeded: 0, retried: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    // Every line logged while the job runs — the runner's own included — carries `jobId`, and
    // the id of the request that enqueued it as `requestId`.
    const context = { requestId: job.traceId ?? undefined, jobId: job.id };
    try {
      const outcome = await runWithContext(context, () => runOne(job, now, workerId));
      result[outcome] += 1;
    } catch (err) {
      // Bookkeeping itself failed (e.g. the database went away). Leave this job to stale-lock
      // recovery and keep going, so one bad write does not strand the rest of the batch.
      runWithContext(context, () => logger.error('job bookkeeping failed', { type: job.type, err }));
    }
  }

  // Serverless callers (`POST /api/internal/jobs/run`, `npm run jobs:run`) may be frozen or exit
  // right after this returns, so send captured job failures now. No-op without `SENTRY_DSN`.
  await flushSentry(2000);

  return result;
}

export interface RecoverStaleJobsResult {
  /** Returned to `PENDING` to be claimed again. */
  requeued: number;
  /** Already at `maxAttempts`, so marked `FAILED` instead of looping forever. */
  failed: number;
}

/**
 * Releases orphaned `RUNNING` jobs (locked more than 10 minutes before `now`, so their runner
 * died). `attempts` is not refunded — the crashed run counts — and a job that has used up
 * `maxAttempts` is marked `FAILED`: a job that kills its runner every time must not come back
 * every 10 minutes forever.
 */
export async function recoverStaleJobs(now: Date = new Date()): Promise<RecoverStaleJobsResult> {
  const cutoff = new Date(now.getTime() - STALE_LOCK_MS);

  const rows = await prisma.$queryRaw<{ id: string; type: string; status: string; attempts: number }[]>`
    UPDATE "Job"
       SET "status" = CASE WHEN "attempts" >= "maxAttempts" THEN 'FAILED'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
           "lastError" = CASE WHEN "attempts" >= "maxAttempts" THEN ${STALE_EXHAUSTED_ERROR} ELSE "lastError" END,
           "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = ${sqlTimestamp(now)}
     WHERE "status" = 'RUNNING' AND "lockedAt" < ${sqlTimestamp(cutoff)}
    RETURNING "id", "type", "status"::text AS "status", "attempts"`;

  const failed = rows.filter((row) => row.status === 'FAILED');
  for (const row of failed) {
    logger.error('job failed', { jobId: row.id, type: row.type, attempts: row.attempts, reason: STALE_EXHAUSTED_ERROR });
  }

  const result = { requeued: rows.length - failed.length, failed: failed.length };
  if (rows.length > 0) {
    logger.warn('recovered stale jobs', { ...result });
  }
  return result;
}
