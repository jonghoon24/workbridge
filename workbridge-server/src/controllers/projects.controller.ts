import type { NextFunction, Request, Response } from 'express';
import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { notifyMany } from '../lib/notifications/notify';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { expandSkillSearchTerms } from '../lib/skills';
import type { ProjectListQuery } from '../schemas/projects';
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

      // A pending or active contract belongs to the freelancer too; deleting the project would
      // hide it from them (every contract path 404s on a deleted project). Completed is fine.
      const unfinished = await tx.contract.findFirst({
        where: { projectId: project.id, status: { in: ['PENDING', 'ACTIVE'] } },
        select: { id: true },
      });
      if (unfinished) {
        throw new AppError('Cannot delete a project with an unfinished contract', 409);
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
 * over a running contract.
 */
const validTransitions: ProjectStatusTransitions = {
  UPCOMING: ['OPEN', 'CANCELLED', 'CLOSED'],
  OPEN: ['CANCELLED', 'CLOSED'],
  IN_PROGRESS: [],
  COMPLETED: [],
  CANCELLED: [],
  CLOSED: [],
};

export async function updateProjectStatus(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `projectStatusBody`: a ProjectStatus; the transition table is checked below.
    const status: ProjectStatus = req.body.status;

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        applications: { select: { freelancerId: true } },
      },
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

    const updated = await prisma.$transaction(async (tx) => {
      const changedProject = await tx.project.update({
        where: { id: req.params.id },
        data: { status },
      });

      if (status === 'CLOSED') {
        await rejectPendingApplicationsForClosedProjects({ projectId: req.params.id }, tx);
      }

      const recipientIds = [...new Set(project.applications.map((application) => application.freelancerId))];
      if (status === 'CLOSED' && recipientIds.length > 0) {
        // Inline wording (not in the template table), routed through `notifyMany()` for preferences
        // and email.
        await notifyMany(tx, recipientIds.map((userId) => ({
          userId,
          type: 'PROJECT_STATUS_CHANGED' as const,
          title: '프로젝트 모집이 마감되었습니다',
          message: `'${project.title}' 프로젝트 모집이 마감되었습니다.`,
          href: '/my/applications',
        })));
      }

      return changedProject;
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
