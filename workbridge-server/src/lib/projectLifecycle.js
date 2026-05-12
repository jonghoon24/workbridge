import prisma from './prisma.js';

export async function rejectPendingApplicationsForClosedProjects(applicationWhere = {}, client = prisma) {
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

export async function closeExpiredOpenProjects() {
  return prisma.$transaction(async (tx) => {
    const expiredProjects = await tx.project.findMany({
      where: {
        status: { in: ['UPCOMING', 'OPEN'] },
        deletedAt: null,
        deadline: { lt: new Date() },
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
        deadline: { lt: new Date() },
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
