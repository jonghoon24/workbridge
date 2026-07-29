import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from './prisma.js';
import type { PrismaTransactionClient } from '../types/index.js';

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
) {
  return client.application.updateMany({
    where: {
      ...applicationWhere,
      status: 'PENDING',
      project: {
        status: 'CLOSED',
        deletedAt: null,
      },
    },
    data: { status: 'REJECTED' },
  });
}

export async function closeExpiredOpenProjects(): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

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
