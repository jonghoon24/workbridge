import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from './prisma';
import type { PrismaTransactionClient } from '../types/index';

export function getProjectStatusForRecruitmentStart(
  recruitmentStartDate: Date | string | null | undefined,
  now: Date = new Date(),
): ProjectStatus {
  if (recruitmentStartDate && new Date(recruitmentStartDate) > now) {
    return 'UPCOMING';
  }

  return 'OPEN';
}

export async function rejectPendingApplicationsForClosedProjects(
  applicationWhere: Prisma.ApplicationWhereInput = {},
  client: PrismaTransactionClient = prisma,
  // CLOSED for the sweeps; `PATCH /:id/status` also passes CANCELLED for the project it cancels.
  projectStatus: Extract<ProjectStatus, 'CLOSED' | 'CANCELLED'> = 'CLOSED',
) {
  return client.application.updateMany({
    where: {
      ...applicationWhere,
      status: 'PENDING',
      project: {
        status: projectStatus,
        deletedAt: null,
      },
    },
    data: { status: 'REJECTED' },
  });
}

/**
 * The lifecycle sweep (docs/domain/projects-contracts.md). Runs lazily on read paths (no argument, so "now")
 * and from the scheduled `project.lifecycleSweep` job, which passes the runner's `now` so the
 * job is deterministic under test. Idempotent.
 */
export async function closeExpiredOpenProjects(now: Date = new Date()): Promise<string[]> {
  return prisma.$transaction(async (tx) => {

    await tx.project.updateMany({
      where: {
        status: 'UPCOMING',
        deletedAt: null,
        recruitmentStartDate: { lte: now },
        deadline: { gte: now },
      },
      data: { status: 'OPEN' },
    });

    const expiredProjects = await tx.project.findMany({
      where: {
        status: { in: ['UPCOMING', 'OPEN'] },
        deletedAt: null,
        deadline: { lt: now },
      },
      select: {
        id: true,
      },
    });

    if (expiredProjects.length === 0) return [];

    const projectIds = expiredProjects.map((project) => project.id);

    await tx.project.updateMany({
      where: {
        id: { in: projectIds },
        status: { in: ['UPCOMING', 'OPEN'] },
        deletedAt: null,
        deadline: { lt: now },
      },
      data: { status: 'CLOSED' },
    });

    await rejectPendingApplicationsForClosedProjects(
      { projectId: { in: projectIds } },
      tx,
    );

    return projectIds;
  });
}
