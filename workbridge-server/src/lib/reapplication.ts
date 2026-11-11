import type { Application } from '@prisma/client';

import prisma from './prisma';
import type { PrismaTransactionClient } from '../types/index';

/**
 * Who may apply again to a project that recruits again after a cancelled contract
 * (docs/domain/projects-contracts.md "다시 모집하기"). An applicant has one application row per project
 * (`@@unique([projectId, freelancerId])`); re-applying resets that row to `PENDING` with the new
 * content and `createdAt` (the time of the latest submission).
 *
 * A round ends with the contract that came out of it. An application submitted before the
 * project's latest cancelled contract was created and rejected — at the accept, or earlier — belongs
 * to that ended round, so its applicant may apply again once the project is `OPEN`. An application
 * rejected in the current round, and the accepted application of the cancelled contract (its
 * freelancer), may not.
 */

/** The `createdAt` of each project's latest cancelled contract; projects without one are absent. */
export async function latestCancelledContractAt(
  projectIds: readonly string[],
  client: PrismaTransactionClient = prisma,
): Promise<Map<string, Date>> {
  if (projectIds.length === 0) return new Map();
  const rows = await client.contract.groupBy({
    by: ['projectId'],
    where: { projectId: { in: [...projectIds] }, status: 'CANCELLED' },
    _max: { createdAt: true },
  });
  const cutoffs = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.createdAt) cutoffs.set(row.projectId, row._max.createdAt);
  }
  return cutoffs;
}

/** Whether this application's applicant may apply again, given the project's cutoff. */
export function isFromEndedRound(
  application: Pick<Application, 'status' | 'createdAt'>,
  cutoff: Date | undefined,
): boolean {
  return application.status === 'REJECTED' && cutoff !== undefined && application.createdAt < cutoff;
}
