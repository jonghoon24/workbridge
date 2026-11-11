// Imported as a value, not a type: the `instanceof` checks below need the runtime object.
import { Prisma } from '@prisma/client';
import type { ApplicationStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import {
  closeExpiredOpenProjects,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { notify, notifyRecipients } from '../lib/notifications/notify';
import { lockActiveUserRow } from '../lib/locks';
import { isFromEndedRound, latestCancelledContractAt } from '../lib/reapplication';
import { createDefaultMilestone, defaultMilestoneDueDate } from './milestones.service';
import { openContractConversation } from './messaging.service';
import type { ApplicationCreateInput, ApplicationDecisionInput } from '../schemas/applications';

/**
 * Applications (docs/domain/projects-contracts.md "지원", "지원 수락과 계약 체결"): a freelancer
 * applies (or applies again after a round that ended with a cancelled contract), the owning client
 * lists and decides them. Accepting creates the contract in one transaction whose lock order —
 * `Project` → `Application` → `User` — is shared with applying and withdrawal (docs/DATABASE.md
 * "동시성").
 */

const ALREADY_APPLIED = 'You have already applied to this project';

/**
 * `POST /api/projects/:id/applications`. Parsed by `applicationCreateBody`: `expectedRate` is a
 * whole number of won >= 1; it becomes the contract amount. **Writes rows** before anything else:
 * the lifecycle sweep runs first.
 */
export async function submitApplication(
  projectId: string,
  freelancerId: string,
  input: ApplicationCreateInput,
  now: Date,
) {
  const { coverLetter, expectedRate, expectedDuration } = input;

  // The sweep closes every project whose deadline has passed (and rejects its pending
  // applications), so an `OPEN` project read after it is still before its deadline. A past
  // deadline therefore surfaces as the not-OPEN 400 below — there is no separate deadline check.
  await closeExpiredOpenProjects(now);

  // A project whose client is soft-deleted takes no applications (and so sends that client nothing).
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, client: { deletedAt: null } },
  });

  if (!project) {
    throw new AppError('Project not found', 404);
  }

  if (project.status !== 'OPEN') {
    throw new AppError('Project is not accepting applications', 400);
  }

  const freelancer = await prisma.user.findUnique({
    where: { id: freelancerId },
    select: { name: true, email: true },
  });
  const applicantName = freelancer?.name || freelancer?.email || '프리랜서';

  // Only the transaction is inside this try, so its catch sees database errors only.
  try {
    return await prisma.$transaction(async (tx) => {
      // Locks in the order accepting an application and withdrawing take them: Project →
      // Application → User (docs/DATABASE.md "동시성"). Re-applying updates an existing
      // application row, so taking the user row first would cycle with a withdrawal that holds
      // that application row and waits for the user row.
      //
      // The project is share-locked and read again: an accept or a close that committed after
      // the reads above must not get a pending application back on a project that is no longer
      // recruiting (an accept takes the project row FOR UPDATE, so it waits for this, or this
      // waits for it and sees CLOSED).
      const [current] = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR SHARE`;
      if (!current) throw new AppError('Project not found', 404);
      if (current.status !== 'OPEN') throw new AppError('Project is not accepting applications', 400);

      // One row per applicant and project. An applicant rejected in a round that ended with a
      // cancelled contract applies again on the same row (`lib/reapplication.ts`); anyone else
      // who already applied is a 409. The row is locked so two applies of this freelancer cannot
      // both reset it; a concurrent first apply loses on the unique constraint (P2002 below).
      const [existing] = await tx.$queryRaw<{ id: string; status: ApplicationStatus; createdAt: Date }[]>`
        SELECT "id", "status", "createdAt" FROM "Application"
        WHERE "projectId" = ${projectId} AND "freelancerId" = ${freelancerId} FOR UPDATE`;

      // A withdrawal that committed after `requireActiveUser` must not get an application back
      // (it deleted this freelancer's undecided applications): 401 like the guard.
      await lockActiveUserRow(tx, freelancerId);

      let created;
      if (existing) {
        const cutoffs = await latestCancelledContractAt([projectId], tx);
        if (!isFromEndedRound(existing, cutoffs.get(projectId))) {
          throw new AppError(ALREADY_APPLIED, 409);
        }
        created = await tx.application.update({
          where: { id: existing.id },
          data: { coverLetter, expectedRate, expectedDuration, status: 'PENDING', createdAt: now },
        });
      } else {
        created = await tx.application.create({
          data: {
            projectId,
            freelancerId,
            coverLetter,
            expectedRate,
            expectedDuration,
            status: 'PENDING',
          },
        });
      }

      // The wording stays inline here (not in the template table); `notify()` applies the channel
      // policy and preferences. The client is live: a deleted client's project 404s above.
      await notify(tx, {
        userId: project.clientId,
        type: 'APPLICATION_CREATED',
        title: '새 지원자가 있습니다',
        message: `${applicantName}님이 '${project.title}' 프로젝트에 지원했습니다.`,
        href: `/projects/${projectId}/applications`,
      }, now);

      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(ALREADY_APPLIED, 409);
    }
    throw err;
  }
}

/**
 * `GET /api/projects/:id/applications`, newest first. **Writes rows**: the project's stale pending
 * applications are rejected first when it has closed.
 */
export async function listProjectApplications(projectId: string, clientId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) {
    throw new AppError('Project not found', 404);
  }

  if (project.clientId !== clientId) {
    throw new AppError('Not authorized', 403);
  }

  await rejectPendingApplicationsForClosedProjects({ projectId });

  // A soft-deleted freelancer's application is gone for the client too (and cannot be decided).
  return prisma.application.findMany({
    where: { projectId, freelancer: { deletedAt: null } },
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
}

/**
 * `PATCH /api/projects/:projectId/applications/:appId`. Parsed by `applicationDecisionBody`:
 * `ACCEPTED` or `REJECTED`. Accepting returns `{ application, contract }`; rejecting returns the
 * application.
 */
export async function decideApplication(
  projectId: string,
  appId: string,
  clientId: string,
  { status }: ApplicationDecisionInput,
  now: Date,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) {
    throw new AppError('Project not found', 404);
  }

  if (project.clientId !== clientId) {
    throw new AppError('Not authorized', 403);
  }

  // A soft-deleted freelancer's application does not exist for the client: no contract with them.
  const application = await prisma.application.findFirst({
    where: { id: appId, projectId, freelancer: { deletedAt: null } },
  });

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  // Only a pending application can be decided. Without this, accepting an already-decided
  // application would proceed and attempt a second live Contract on the project — and there is
  // at most one per project (a partial unique index), so that surfaced as a 500 rather than a conflict.
  if (application.status !== 'PENDING') {
    throw new AppError('This application has already been processed', 409);
  }

  if (status === 'ACCEPTED') {
    // Atomic transaction: accept application, reject others, create contract and its default
    // milestone, close recruitment, notify, open the conversation (steps 1–7 below).
    const milestoneDueDate = defaultMilestoneDueDate(now);
    try {
      return await prisma.$transaction(async (tx) => {
        // Lock the project row first. Accepts of one project then run one at a time: without
        // it, two accepts each locked their own application and then waited on the other's to
        // reject it — a deadlock (40P01, a 500). The loser now waits, then hits the unique
        // contract below (409). A project deleted while this waited is gone (404).
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) {
          throw new AppError('Project not found', 404);
        }

        // Accept only while still pending and the applicant still active, under the application's
        // row lock: a withdrawal that deleted it while this waited (or an operator deletion) is
        // a 404, a decision that landed first a 409 — never a contract with a withdrawn user.
        const accepted = await tx.application.updateMany({
          where: { id: appId, projectId, status: 'PENDING', freelancer: { deletedAt: null } },
          data: { status: 'ACCEPTED' },
        });
        if (accepted.count === 0) {
          const current = await tx.application.findFirst({
            where: { id: appId, projectId, freelancer: { deletedAt: null } },
            select: { id: true },
          });
          if (!current) throw new AppError('Application not found', 404);
          // Lost to a concurrent accept of another application on this project (it rejected this
          // one before this accept got the project row): the same conflict as the unique contract.
          // A cancelled contract does not count — the project may have recruited again since.
          if (await tx.contract.findFirst({ where: { projectId, status: { not: 'CANCELLED' } }, select: { id: true } })) {
            throw new AppError('A contract already exists for this project', 409);
          }
          throw new AppError('This application has already been processed', 409);
        }
        const updatedApp = await tx.application.findUniqueOrThrow({ where: { id: appId } });

        const rejectedApplications = await tx.application.findMany({
          where: { projectId, id: { not: appId }, status: 'PENDING' },
          select: { freelancer: { select: { id: true, deletedAt: true } } },
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

        await notifyRecipients(tx, rejectedApplications.map((rejected) => rejected.freelancer), {
          type: 'APPLICATION_REJECTED',
          title: '지원 결과를 알려 드립니다',
          message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
          href: '/my/applications',
        }, now);

        // 7. The conversation, its participants and `CONTRACT_CREATED` — last, so the
        // conversation lock is the last one taken.
        await openContractConversation(tx, contract);

        return { application: updatedApp, contract };
      });
    } catch (err) {
      // One contract per project that is not CANCELLED (the partial unique index
      // "Contract_projectId_live_key"). The PENDING guard above stops the common case, but
      // two concurrent accepts of *different* pending applications on the same project can
      // both pass it — the constraint is the real backstop, so surface it as a conflict
      // rather than letting P2002 become a 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('A contract already exists for this project', 409);
      }
      throw err;
    }
  }

  return prisma.$transaction(async (tx) => {
    // Only while still pending, as accepting does: an accept (or another reject) that committed
    // after the check above wins, and this one is the same 409 — no second decision, no second
    // notification (#135).
    const { count } = await tx.application.updateMany({
      where: { id: appId, projectId, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    if (count === 0) {
      throw new AppError('This application has already been processed', 409);
    }
    const rejected = await tx.application.findUniqueOrThrow({ where: { id: appId } });

    await notify(tx, {
      userId: application.freelancerId,
      type: 'APPLICATION_REJECTED',
      title: '지원 결과를 알려 드립니다',
      message: `'${project.title}' 프로젝트 지원이 거절되었습니다.`,
      href: '/my/applications',
    }, now);

    return rejected;
  });
}
