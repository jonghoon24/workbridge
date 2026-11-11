import type { NextFunction, Request, Response } from 'express';
import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { notifyRecipients } from '../lib/notifications/notify';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { expandSkillSearchTerms } from '../lib/skills';
import type { ProjectListQuery, ProjectStatusInput } from '../schemas/projects';
import type { AuthedRequest, ProjectStatusTransitions } from '../types/index';

function validateRecruitmentSchedule(recruitmentStartDate: Date, deadline: Date) {
  if (recruitmentStartDate > deadline) {
    throw new AppError('recruitmentStartDate cannot be after deadline', 400);
  }
}

export async function getProjects(_req: Request, res: Response, next: NextFunction) {
  try {
    await closeExpiredOpenProjects();

    // Parsed by `projectListQuery`: defaults applied, `limit` capped, budgets ordered.
    const {
      search,
      category,
      minBudget,
      maxBudget,
      skills,
      status,
      sort,
      page: pageNum,
      limit: limitNum,
    } = res.locals.query as ProjectListQuery;

    // A project whose client is soft-deleted is hidden like a deleted project (docs/domain/README.md).
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      client: { deletedAt: null },
    };

    if (status !== 'ALL') {
      where.status = status;
    }

    if (search) {
      // Prisma passes `contains` to ILIKE unescaped: `%` and `_` would be wildcards (`search=%`
      // matched every project). Escape them, and the escape character itself (Postgres' default
      // `\`), so the search matches literally.
      const literal = search.replace(/[\\%_]/g, '\\$&');
      where.OR = [
        { title: { contains: literal, mode: 'insensitive' } },
        { description: { contains: literal, mode: 'insensitive' } },
      ];
    }

    if (category) where.category = category;
    if (minBudget !== undefined || maxBudget !== undefined) {
      where.budget = {};
      if (minBudget !== undefined) where.budget.gte = minBudget;
      if (maxBudget !== undefined) where.budget.lte = maxBudget;
    }
    if (skills) {
      const skillArray = expandSkillSearchTerms(skills);
      if (skillArray.length > 0) {
        where.requiredSkills = { hasSome: skillArray };
      }
    }

    const orderBy: Prisma.ProjectOrderByWithRelationInput = sort === 'deadline'
      ? { deadline: 'asc' }
      : sort === 'budget'
      ? { budget: 'desc' }
      : { createdAt: 'desc' };

    const skip = (pageNum - 1) * limitNum;

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        orderBy,
        skip,
        take: limitNum,
        include: {
          client: { select: { id: true, name: true, companyName: true, profileImage: true } },
          _count: { select: { applications: true } },
        },
      }),
      prisma.project.count({ where }),
    ]);

    res.json({
      projects,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function createProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `projectCreateBody`: dates are Dates, skills normalized.
    const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = req.body;
    const parsedRecruitmentStartDate: Date = recruitmentStartDate ?? new Date();
    validateRecruitmentSchedule(parsedRecruitmentStartDate, deadline);

    const project = await prisma.project.create({
      data: {
        title,
        description,
        category,
        budget,
        recruitmentStartDate: parsedRecruitmentStartDate,
        deadline,
        requiredSkills,
        clientId: req.user.id,
        status: getProjectStatusForRecruitmentStart(parsedRecruitmentStartDate),
      },
    });

    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
}

export async function getProjectById(req: Request, res: Response, next: NextFunction) {
  try {
    await closeExpiredOpenProjects();

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null, client: { deletedAt: null } },
      include: {
        client: {
          select: { id: true, name: true, companyName: true, profileImage: true, businessField: true },
        },
        _count: { select: { applications: true } },
      },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    res.json(project);
  } catch (err) {
    next(err);
  }
}

/**
 * The live project a bookmark route acts on; a missing or soft-deleted project, or one whose client
 * is soft-deleted, is 404 — as on the detail page.
 */
async function findBookmarkableProject(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, client: { deletedAt: null } },
    select: { id: true },
  });

  if (!project) {
    throw new AppError('Project not found', 404);
  }

  return project;
}

export async function getProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await findBookmarkableProject(req.params.id);

    const bookmark = await prisma.projectBookmark.findUnique({
      where: {
        projectId_userId: {
          projectId: req.params.id,
          userId: req.user.id,
        },
      },
      select: { id: true },
    });

    res.json({ bookmarked: !!bookmark });
  } catch (err) {
    next(err);
  }
}

export async function createProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await findBookmarkableProject(req.params.id);

    // `INSERT … ON CONFLICT DO NOTHING`, not `upsert`: Prisma's upsert on a compound key is
    // find-then-insert, so an overlapping request for the same bookmark hit P2002 (a 500). An
    // existing row is left as it is (same id and createdAt).
    await prisma.projectBookmark.createMany({
      data: [{ projectId: req.params.id, userId: req.user.id }],
      skipDuplicates: true,
    });

    res.status(201).json({ bookmarked: true });
  } catch (err) {
    next(err);
  }
}

export async function deleteProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await findBookmarkableProject(req.params.id);

    // No bookmark on a live project is still a success (idempotent).
    await prisma.projectBookmark.deleteMany({
      where: {
        projectId: req.params.id,
        userId: req.user.id,
      },
    });

    res.json({ bookmarked: false });
  } catch (err) {
    next(err);
  }
}

export async function updateProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { _count: { select: { applications: true } } },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    // Parsed by `projectUpdateBody`: absent fields are `undefined`, dates are Dates.
    const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = req.body;
    const updateData: Prisma.ProjectUpdateInput = {};

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (requiredSkills !== undefined) updateData.requiredSkills = requiredSkills;

    // Restrict pricing and recruitment schedule changes if applications exist.
    if (project._count.applications > 0) {
      if (budget !== undefined || recruitmentStartDate !== undefined || deadline !== undefined) {
        throw new AppError('Cannot change budget or recruitment dates after applications have been submitted', 400);
      }
    } else {
      if (budget !== undefined) updateData.budget = budget;

      const parsedDeadline: Date = deadline ?? project.deadline;
      const parsedRecruitmentStartDate: Date = recruitmentStartDate ?? project.recruitmentStartDate ?? new Date();

      validateRecruitmentSchedule(parsedRecruitmentStartDate, parsedDeadline);

      if (deadline !== undefined) updateData.deadline = parsedDeadline;
      if (recruitmentStartDate !== undefined) {
        updateData.recruitmentStartDate = parsedRecruitmentStartDate;
      }
      if (
        ['UPCOMING', 'OPEN'].includes(project.status)
        && (deadline !== undefined || recruitmentStartDate !== undefined)
      ) {
        updateData.status = getProjectStatusForRecruitmentStart(parsedRecruitmentStartDate);
      }
    }

    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    await prisma.$transaction(async (tx) => {
      // Lock the project row so the contract check and the delete see the same state: an accept
      // that commits a contract first makes this a 409 instead of orphaning a live contract.
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id} FOR UPDATE`;

      // A contract belongs to the freelancer too: deleting the project would hide it from them
      // (every contract path 404s on a deleted project), along with its conversation. So any
      // contract keeps the project — a pending or active one, and also a completed or cancelled
      // one, which is the counterpart's record (docs/domain/projects-contracts.md "수정과 삭제").
      const contracts = await tx.contract.findMany({
        where: { projectId: project.id },
        select: { status: true },
      });
      if (contracts.some((c) => c.status === 'PENDING' || c.status === 'ACTIVE')) {
        throw new AppError('Cannot delete a project with an unfinished contract', 409);
      }
      if (contracts.length > 0) {
        throw new AppError('Cannot delete a project with a contract record', 409);
      }

      await tx.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });
    });

    res.json({ message: 'Project deleted successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * The client's manual transitions only. `IN_PROGRESS` has none: signing moves a project there and
 * approving the last milestone completes it, so a client cannot skip the milestones or cancel
 * over a running contract. `CLOSED → OPEN` is recruiting again ("다시 모집하기"): it takes a new
 * deadline and is refused while the project has a contract that is not cancelled.
 */
const validTransitions: ProjectStatusTransitions = {
  UPCOMING: ['OPEN', 'CANCELLED', 'CLOSED'],
  OPEN: ['CANCELLED', 'CLOSED'],
  IN_PROGRESS: [],
  COMPLETED: [],
  CANCELLED: [],
  CLOSED: ['OPEN'],
};

const REOPEN_DEADLINE_REQUIRED = 'Deadline is required to reopen recruitment';
const REOPEN_DEADLINE_PAST = 'Deadline must not be in the past';
const DEADLINE_ONLY_ON_REOPEN = 'Deadline can only be set when reopening recruitment';
const REOPEN_WITH_CONTRACT = 'Cannot reopen recruitment while the project has a contract';

export async function updateProjectStatus(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `projectStatusBody`: a ProjectStatus and, to reopen, a deadline (a KST date lasts
    // until that day ends); the transition table is checked below.
    const { status, deadline } = req.body as ProjectStatusInput;
    const now = new Date();

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    if (project.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    if (!validTransitions[project.status]?.includes(status)) {
      throw new AppError(`Cannot transition from ${project.status} to ${status}`, 400);
    }

    const reopening = project.status === 'CLOSED' && status === 'OPEN';
    if (!reopening && deadline !== undefined) {
      throw new AppError(DEADLINE_ONLY_ON_REOPEN, 400);
    }
    if (reopening) {
      if (deadline === undefined) throw new AppError(REOPEN_DEADLINE_REQUIRED, 400);
      // The lifecycle sweep would close it again at once (the same `deadline < now` rule).
      if (deadline < now) throw new AppError(REOPEN_DEADLINE_PAST, 400);
      // The schedule every other deadline write keeps: a project closed while still UPCOMING may
      // start recruiting later than the new deadline.
      if (project.recruitmentStartDate) validateRecruitmentSchedule(project.recruitmentStartDate, deadline);
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (reopening) {
        // Lock the project row so the contract check and the reopen see the same state, as a
        // delete does. A contract awaiting signatures (or any contract that is not cancelled)
        // keeps recruitment closed: cancelling it first is the way out.
        const [locked] = await tx.$queryRaw<{ status: ProjectStatus }[]>`
          SELECT "status" FROM "Project" WHERE "id" = ${project.id} AND "deletedAt" IS NULL FOR UPDATE`;
        if (!locked) throw new AppError('Project not found', 404);
        if (locked.status !== 'CLOSED') throw new AppError(`Cannot transition from ${locked.status} to ${status}`, 400);
        const live = await tx.contract.findFirst({
          where: { projectId: project.id, status: { not: 'CANCELLED' } },
          select: { id: true },
        });
        if (live) throw new AppError(REOPEN_WITH_CONTRACT, 409);

        // Nobody is notified: the earlier applicants were already told of their result, and the
        // ones who may apply again see it in their applications.
        // `UPCOMING` instead when the project was closed before its recruitment even started.
        return tx.project.update({
          where: { id: project.id },
          data: { status: getProjectStatusForRecruitmentStart(project.recruitmentStartDate, now), deadline },
        });
      }

      // Read the pending applicants before they are rejected: only they hear that recruitment
      // closed. Applicants already decided (or rejected in an earlier round) were told already.
      const pending = status === 'CLOSED'
        ? await tx.application.findMany({
          where: { projectId: project.id, status: 'PENDING' },
          select: { freelancer: { select: { id: true, deletedAt: true } } },
        })
        : [];

      const changedProject = await tx.project.update({
        where: { id: req.params.id },
        data: { status },
      });

      if (status === 'CLOSED') {
        await rejectPendingApplicationsForClosedProjects({ projectId: req.params.id }, tx);
        // Inline wording (not in the template table), routed through `notifyRecipients()` for
        // preferences and email, and to skip a deleted applicant.
        await notifyRecipients(tx, pending.map((application) => application.freelancer), {
          type: 'PROJECT_STATUS_CHANGED',
          title: '프로젝트 모집이 마감되었습니다',
          message: `'${project.title}' 프로젝트 모집이 마감되었습니다.`,
          href: '/my/applications',
        }, now);
      }

      return changedProject;
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
