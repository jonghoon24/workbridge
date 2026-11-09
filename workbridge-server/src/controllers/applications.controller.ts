import type { NextFunction, Response } from 'express';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
// Imported as a value, not a type: the `instanceof` check below needs the runtime object.
import { Prisma } from '@prisma/client';
import {
  closeExpiredOpenProjects,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { createDefaultMilestone, defaultMilestoneDueDate } from '../services/milestones.service';
import { openContractConversation } from '../services/messaging.service';
import { notify, notifyMany } from '../lib/notifications/notify';
import type { AuthedRequest } from '../types/index';

export async function apply(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `applicationCreateBody`: `expectedRate` is a number >= 1; it may be fractional and becomes the contract amount.
    const { coverLetter, expectedRate, expectedDuration } = req.body;
    const projectId = req.params.id;

    await closeExpiredOpenProjects();

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
            expectedRate,
            expectedDuration,
            status: 'PENDING',
          },
        });

        // The wording stays inline here (not in the template table); `notify()` applies the channel
        // policy and preferences. The client is notified even when soft-deleted (joined owners: #20).
        await notify(tx, {
          userId: project.clientId,
          type: 'APPLICATION_CREATED',
          title: '새 지원자가 있습니다',
          message: `${applicantName}님이 '${project.title}' 프로젝트에 지원했습니다.`,
          href: `/projects/${projectId}/applications`,
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

export async function getApplications(req: AuthedRequest, res: Response, next: NextFunction) {
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
        project: { select: { budget: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(applications);
  } catch (err) {
    next(err);
  }
}

export async function updateApplication(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { projectId, appId } = req.params;
    // Parsed by `applicationDecisionBody`: `ACCEPTED` or `REJECTED`.
    const { status } = req.body;

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

    // Only a pending application can be decided. Without this, accepting an already-decided
    // application would proceed and attempt a second Contract on the project — and
    // `Contract.projectId` is unique, so that surfaced as a 500 rather than a conflict.
    if (application.status !== 'PENDING') {
      throw new AppError('This application has already been processed', 409);
    }

    if (status === 'ACCEPTED') {
      // Atomic transaction: accept application, reject others, create contract and its default
      // milestone, close recruitment, notify, open the conversation (steps 1–7 below).
      const now = new Date();
      const milestoneDueDate = defaultMilestoneDueDate(now);
      let result;
      try {
        result = await prisma.$transaction(async (tx) => {
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
              amount: application.expectedRate,
              startDate: now,
              // The last milestone's due date — not the recruitment deadline, which may have
              // passed already.
              endDate: milestoneDueDate,
              status: 'PENDING',
            },
          });

          await createDefaultMilestone(tx, contract, milestoneDueDate);

          await tx.project.update({
            where: { id: projectId },
            data: { status: 'CLOSED' },
          });

          await notify(tx, {
            userId: application.freelancerId,
            type: 'APPLICATION_ACCEPTED',
            title: '지원이 수락되었습니다',
            message: `'${project.title}' 프로젝트 지원이 수락되었습니다. 계약서를 확인해 주세요.`,
            href: `/contracts/${contract.id}`,
          }, now);

          await notifyMany(tx, rejectedApplications.map((rejected) => ({
            userId: rejected.freelancerId,
            type: 'APPLICATION_REJECTED' as const,
            title: '지원 결과를 알려 드립니다',
            message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
            href: '/my/applications',
          })), now);

          // 7. The conversation, its participants and `CONTRACT_CREATED` — last, so the
          // conversation lock is the last one taken.
          await openContractConversation(tx, contract);

          return { application: updatedApp, contract };
        });
      } catch (err) {
        // `Contract.projectId` is unique. The PENDING guard above stops the common case, but
        // two concurrent accepts of *different* pending applications on the same project can
        // both pass it — the constraint is the real backstop, so surface it as a conflict
        // rather than letting P2002 become a 500.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError('A contract already exists for this project', 409);
        }
        throw err;
      }

      res.json(result);
    } else {
      const updated = await prisma.$transaction(async (tx) => {
        const rejected = await tx.application.update({
          where: { id: appId },
          data: { status: 'REJECTED' },
        });

        await notify(tx, {
          userId: application.freelancerId,
          type: 'APPLICATION_REJECTED',
          title: '지원 결과를 알려 드립니다',
          message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
          href: '/my/applications',
        });

        return rejected;
      });

      res.json(updated);
    }
  } catch (err) {
    next(err);
  }
}
