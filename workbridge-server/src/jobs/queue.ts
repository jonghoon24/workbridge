import type { Prisma } from '@prisma/client';

import { getRequestContext } from '../lib/requestContext';
import type { PrismaTransactionClient } from '../types/index';
import type { JobPayloads, JobType } from './types';

export interface EnqueueJobInput<T extends JobType> {
  type: T;
  payload?: JobPayloads[T];
  /** Defaults to now. */
  runAt?: Date;
  /** Enqueueing a key that already exists — in any status — is a silent no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/**
 * Enqueues a job. Call it with the transaction client of the state change that causes the job
 * (transactional outbox), so a rolled-back change never leaves a job behind.
 *
 * Implemented as `createMany({ skipDuplicates: true })` — `INSERT … ON CONFLICT DO NOTHING` —
 * rather than `create` + catching P2002: inside an interactive transaction Postgres aborts the
 * whole transaction on the first failed statement, so a caught P2002 would still poison it.
 *
 * Returns `true` if a row was inserted, `false` if the `dedupeKey` already existed.
 */
export async function enqueueJob<T extends JobType>(
  client: PrismaTransactionClient,
  input: EnqueueJobInput<T>,
): Promise<boolean> {
  const { count } = await client.job.createMany({
    data: [
      {
        type: input.type,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        runAt: input.runAt ?? new Date(),
        dedupeKey: input.dedupeKey,
        maxAttempts: input.maxAttempts,
        traceId: getRequestContext()?.requestId,
      },
    ],
    skipDuplicates: true,
  });

  return count === 1;
}
