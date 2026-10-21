import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Job } from '@prisma/client';

import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { runWithContext } from '../lib/requestContext';
import { HOUR_MS, MINUTE_MS } from '../lib/time';
import { sqlTimestamp } from '../lib/sql';
import { PermanentJobError } from './errors';
import { enqueueNextOccurrence, findRecurringJob } from './recurring';
import { handlerFor } from './registry';
import type { JobType } from './types';

/** A `RUNNING` job whose lock is older than this is assumed orphaned by a dead runner. */
export const STALE_LOCK_MS = 10 * MINUTE_MS;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = HOUR_MS;
const MAX_ERROR_LENGTH = 2000;

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
}

/** `min(30 s × 2^(attempts − 1), 1 h)` — `attempts` already counts the run that just failed. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

/**
 * Atomically moves up to `limit` due `PENDING` jobs to `RUNNING`. `FOR UPDATE SKIP LOCKED`
 * makes concurrent runners skip each other's rows instead of blocking or double-claiming.
 */
async function claimDueJobs(now: Date, limit: number, workerId: string, types?: readonly JobType[]): Promise<Job[]> {
  const typeFilter = types && types.length > 0
    ? Prisma.sql`AND "type" IN (${Prisma.join([...types])})`
    : Prisma.empty;

  const claimed = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
       SET "status" = 'RUNNING', "lockedAt" = ${sqlTimestamp(now)}, "lockedBy" = ${workerId},
           "attempts" = "attempts" + 1, "updatedAt" = ${sqlTimestamp(now)}
     WHERE "id" IN (
       SELECT "id" FROM "Job"
        WHERE "status" = 'PENDING' AND "runAt" <= ${sqlTimestamp(now)} ${typeFilter}
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

type Outcome = 'succeeded' | 'retried' | 'failed';

async function runOne(job: Job, now: Date, workerId: string): Promise<Outcome> {
  // Only touch the row while we still own it: stale-lock recovery may have handed it on.
  const owned = { id: job.id, status: 'RUNNING' as const, lockedBy: workerId };
  const unlock = { lockedAt: null, lockedBy: null };

  // The next slot of a recurring job is enqueued at claim time, not on success, so one slot
  // that retries and finally fails does not break the chain.
  const recurring = findRecurringJob(job.type);
  if (recurring) {
    await enqueueNextOccurrence(recurring, now);
  }

  const handler = handlerFor(job.type);

  try {
    if (!handler) {
      throw new PermanentJobError(`No handler registered for job type "${job.type}"`);
    }

    await runWithContext({ requestId: job.traceId ?? undefined, jobId: job.id }, () => handler({
      job,
      payload: job.payload as never,
      now,
      logger,
    }));

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
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        reason: permanent ? 'permanent' : 'attempts exhausted',
        err,
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
    logger.warn('job will retry', { jobId: job.id, type: job.type, attempts: job.attempts, err });
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
  const result: RunDueJobsResult = { claimed: jobs.length, succeeded: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    const outcome = await runOne(job, now, workerId);
    result[outcome] += 1;
  }

  return result;
}

/**
 * Returns orphaned `RUNNING` jobs (locked more than 10 minutes before `now`) to `PENDING`.
 * `attempts` is not refunded — the crashed run counts.
 */
export async function recoverStaleJobs(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null },
  });

  if (count > 0) {
    logger.warn('recovered stale jobs', { count });
  }
  return count;
}
