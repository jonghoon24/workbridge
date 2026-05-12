import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { Prisma } from '@prisma/client';
import { rejectPendingApplicationsForClosedProjects } from '../lib/projectLifecycle.js';

export async function apply(req, res, next) {
  try {
    const { coverLetter, expectedRate, expectedDuration } = req.body;
    const projectId = req.params.id;

    if (!coverLetter || !expectedRate || !expectedDuration) {
      throw new AppError('All fields are required', 400);
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.status === 'OPEN' && project.deadline < new Date()) {
      await prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: projectId },
          data: { status: 'CLOSED' },
        });

        await rejectPendingApplicationsForClosedProjects({ projectId }, tx);
      });
      throw new AppError('Project deadline has passed', 400);
    }

    if (project.status !== 'OPEN') {
      throw new AppError('Project is not accepting applications', 400);
    }

    const freelancer = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { name: true, email: true },
    });
    const applicantName = freelancer?.name || freelancer?.email || '프리랜서';

    try {
      const application = await prisma.$transaction(async (tx) => {
        const created = await tx.application.create({
          data: {
            projectId,
            freelancerId: req.user.id,
            coverLetter,
            expectedRate: parseFloat(expectedRate),
            expectedDuration,
            status: 'PENDING',
          },
        });

        await tx.notification.create({
          data: {
            userId: project.clientId,
            type: 'APPLICATION_CREATED',
            title: '새 지원자가 도착했습니다',
            message: `${applicantName}님이 '${project.title}' 프로젝트에 지원했습니다.`,
            href: `/projects/${projectId}/applications`,
          },
        });

        return created;
      });

      res.status(201).json(application);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('You have already applied to this project', 409);
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

export async function getApplications(req, res, next) {
  try {
    const projectId = req.params.id;

    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    await rejectPendingApplicationsForClosedProjects({ projectId });

    const applications = await prisma.application.findMany({
      where: { projectId },
      include: {
        freelancer: {
          select: {
            id: true,
            name: true,
            profileImage: true,
            bio: true,
            skills: true,
            activityCategory: true,
            experienceYears: true,
            hourlyRate: true,
            portfolioUrl: true,
          },
        },
        contract: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(applications);
  } catch (err) {
    next(err);
  }
}

export async function updateApplication(req, res, next) {
  try {
    const { projectId, appId } = req.params;
    const { status } = req.body;

    if (!['ACCEPTED', 'REJECTED'].includes(status)) {
      throw new AppError('Status must be ACCEPTED or REJECTED', 400);
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    const application = await prisma.application.findFirst({
      where: { id: appId, projectId },
    });

    if (!application) {
      throw new AppError('Application not found', 404);
    }

    if (status === 'ACCEPTED') {
      // Atomic transaction: accept application, reject others, create contract, update project
      const result = await prisma.$transaction(async (tx) => {
        const rejectedApplications = await tx.application.findMany({
          where: { projectId, id: { not: appId }, status: 'PENDING' },
          select: { freelancerId: true },
        });

        const updatedApp = await tx.application.update({
          where: { id: appId },
          data: { status: 'ACCEPTED' },
        });

        await tx.application.updateMany({
          where: { projectId, id: { not: appId }, status: 'PENDING' },
          data: { status: 'REJECTED' },
        });

        const contract = await tx.contract.create({
          data: {
            projectId,
            applicationId: appId,
            clientId: project.clientId,
            freelancerId: application.freelancerId,
            amount: project.budget,
            startDate: new Date(),
            endDate: project.deadline,
            status: 'PENDING',
          },
        });

        await tx.project.update({
          where: { id: projectId },
          data: { status: 'IN_PROGRESS' },
        });

        await tx.notification.create({
          data: {
            userId: application.freelancerId,
            type: 'APPLICATION_ACCEPTED',
            title: '지원이 수락되었습니다',
            message: `'${project.title}' 프로젝트 지원이 수락되었습니다. 계약서를 확인해주세요.`,
            href: `/contracts/${contract.id}`,
          },
        });

        if (rejectedApplications.length > 0) {
          await tx.notification.createMany({
            data: rejectedApplications.map((rejected) => ({
              userId: rejected.freelancerId,
              type: 'APPLICATION_REJECTED',
              title: '지원 결과가 업데이트되었습니다',
              message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
              href: '/my/applications',
            })),
          });
        }

        return { application: updatedApp, contract };
      });

      res.json(result);
    } else {
      const updated = await prisma.$transaction(async (tx) => {
        const rejected = await tx.application.update({
          where: { id: appId },
          data: { status: 'REJECTED' },
        });

        await tx.notification.create({
          data: {
            userId: application.freelancerId,
            type: 'APPLICATION_REJECTED',
            title: '지원 결과가 업데이트되었습니다',
            message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
            href: '/my/applications',
          },
        });

        return rejected;
      });

      res.json(updated);
    }
  } catch (err) {
    next(err);
  }
}
