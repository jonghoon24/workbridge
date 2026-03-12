import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { Prisma } from '@prisma/client';

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

    if (project.status !== 'OPEN') {
      throw new AppError('Project is not accepting applications', 400);
    }

    try {
      const application = await prisma.application.create({
        data: {
          projectId,
          freelancerId: req.user.id,
          coverLetter,
          expectedRate: parseFloat(expectedRate),
          expectedDuration,
          status: 'PENDING',
        },
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
            experienceYears: true,
            hourlyRate: true,
            portfolioUrl: true,
          },
        },
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

        return { application: updatedApp, contract };
      });

      res.json(result);
    } else {
      const updated = await prisma.application.update({
        where: { id: appId },
        data: { status: 'REJECTED' },
      });

      res.json(updated);
    }
  } catch (err) {
    next(err);
  }
}
