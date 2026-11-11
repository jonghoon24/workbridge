import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError, invalidField } from '../lib/errors';
import { notifyRecipients } from '../lib/notifications/notify';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { expandSkillSearchTerms } from '../lib/skills';
import type {
  ProjectCreateInput,
  ProjectListQuery,
  ProjectStatusInput,
  ProjectUpdateInput,
} from '../schemas/projects';
import type { ProjectStatusTransitions } from '../types/index';

/**
 * Projects (docs/domain/projects-contracts.md): the public list and detail, and the owning client's
 * create, edit, delete and status changes. The list and the detail run the lazy lifecycle sweep
 * first, so those reads **write rows**. Bookmarks are `bookmarks.service.ts`.
 */

function validateRecruitmentSchedule(recruitmentStartDate: Date, deadline: Date) {
  if (recruitmentStartDate > deadline) {
    throw invalidField('deadline', 'CONFLICT', 'recruitmentStartDate cannot be after deadline');
  }
}

/** `GET /api/projects`. **Writes rows**: the lifecycle sweep runs first. */
export async function listProjects(query: ProjectListQuery) {
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
  } = query;

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

  return {
    projects,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    },
  };
}

/**
 * `POST /api/projects`. Parsed by `projectCreateBody`: dates are Dates, skills normalized. An
 * omitted `recruitmentStartDate` is `now`, the request time.
 */
export async function registerProject(clientId: string, input: ProjectCreateInput, now: Date) {
  const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = input;
  const parsedRecruitmentStartDate: Date = recruitmentStartDate ?? now;
  validateRecruitmentSchedule(parsedRecruitmentStartDate, deadline);

  return prisma.project.create({
    data: {
      title,
      description,
      category,
      budget,
      recruitmentStartDate: parsedRecruitmentStartDate,
      deadline,
      requiredSkills,
      clientId,
      status: getProjectStatusForRecruitmentStart(parsedRecruitmentStartDate, now),
    },
  });
}

/** `GET /api/projects/:id`. **Writes rows**: the lifecycle sweep runs first. */
export async function getProjectDetail(projectId: string) {
  await closeExpiredOpenProjects();

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, client: { deletedAt: null } },
    include: {
      client: {
        select: { id: true, name: true, companyName: true, profileImage: true, businessField: true },
      },
      _count: { select: { applications: true } },
    },
  });

  if (!project) {
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
  }

  return project;
}

/** `PATCH /api/projects/:id`. Parsed by `projectUpdateBody`: absent fields are `undefined`, dates are Dates. */
export async function editProject(projectId: string, clientId: string, input: ProjectUpdateInput, now: Date) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { clientId: true },
  });

  if (!project) {
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
  }

  if (project.clientId !== clientId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }

  const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = input;

  return prisma.$transaction(async (tx) => {
    // Lock the project row before counting its applications, as applying (share lock) and
    // accepting (update lock) take it first: an application that commits after this count waits
    // for the edit, and one that committed first is counted — never terms changed under a
    // submitted application (#135). The row is read again under the lock.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
    if (!locked) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
    }
    const current = await tx.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
      include: { _count: { select: { applications: true } } },
    });

    const updateData: Prisma.ProjectUpdateInput = {};

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (requiredSkills !== undefined) updateData.requiredSkills = requiredSkills;

    // Restrict pricing and recruitment schedule changes if applications exist.
    if (current._count.applications > 0) {
      if (budget !== undefined || recruitmentStartDate !== undefined || deadline !== undefined) {
        throw new AppError('PROJECT_TERMS_LOCKED', 'Cannot change budget or recruitment dates after applications have been submitted');
      }
    } else {
      if (budget !== undefined) updateData.budget = budget;

      const parsedDeadline: Date = deadline ?? current.deadline;
      const parsedRecruitmentStartDate: Date = recruitmentStartDate ?? current.recruitmentStartDate ?? now;

      validateRecruitmentSchedule(parsedRecruitmentStartDate, parsedDeadline);

      if (deadline !== undefined) updateData.deadline = parsedDeadline;
      if (recruitmentStartDate !== undefined) {
        updateData.recruitmentStartDate = parsedRecruitmentStartDate;
      }
      if (
        ['UPCOMING', 'OPEN'].includes(current.status)
        && (deadline !== undefined || recruitmentStartDate !== undefined)
      ) {
        updateData.status = getProjectStatusForRecruitmentStart(parsedRecruitmentStartDate, now);
      }
    }

    return tx.project.update({
      where: { id: projectId },
      data: updateData,
    });
  });
}

/** `DELETE /api/projects/:id`: soft-deletes the project at `now`. */
export async function softDeleteProject(projectId: string, clientId: string, now: Date) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) {
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
  }

  if (project.clientId !== clientId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }

  await prisma.$transaction(async (tx) => {
    // Lock the project row so the contract check and the delete see the same state: an accept
    // that commits a contract first makes this a 409 instead of orphaning a live contract. Only a
    // live row: a delete that committed first leaves nothing to lock, and this one is a 404 (#135).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Project" WHERE "id" = ${project.id} AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
    }

    // A contract belongs to the freelancer too: deleting the project would hide it from them
    // (every contract path 404s on a deleted project), along with its conversation. So any
    // contract keeps the project — a pending or active one, and also a completed or cancelled
    // one, which is the counterpart's record (docs/domain/projects-contracts.md "수정과 삭제").
    const contracts = await tx.contract.findMany({
      where: { projectId: project.id },
      select: { status: true },
    });
    if (contracts.some((c) => c.status === 'PENDING' || c.status === 'ACTIVE')) {
      throw new AppError('PROJECT_HAS_ACTIVE_CONTRACT', 'Cannot delete a project with an unfinished contract');
    }
    if (contracts.length > 0) {
      throw new AppError('PROJECT_HAS_CONTRACT_RECORD', 'Cannot delete a project with a contract record');
    }

    await tx.project.update({
      where: { id: project.id },
      data: { deletedAt: now },
    });
  });
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

/**
 * `PATCH /api/projects/:id/status`. Parsed by `projectStatusBody`: a ProjectStatus and, to reopen,
 * a deadline (a KST date lasts until that day ends); the transition table is checked below.
 */
export async function changeProjectStatus(projectId: string, clientId: string, input: ProjectStatusInput, now: Date) {
  const { status, deadline } = input;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) {
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
  }

  if (project.clientId !== clientId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }

  if (!validTransitions[project.status]?.includes(status)) {
    throw new AppError('PROJECT_STATUS_TRANSITION_INVALID', `Cannot transition from ${project.status} to ${status}`);
  }

  const reopening = project.status === 'CLOSED' && status === 'OPEN';
  if (!reopening && deadline !== undefined) {
    throw invalidField('deadline', 'NOT_ALLOWED', DEADLINE_ONLY_ON_REOPEN);
  }
  if (reopening) {
    if (deadline === undefined) throw invalidField('deadline', 'REQUIRED', REOPEN_DEADLINE_REQUIRED);
    // The lifecycle sweep would close it again at once (the same `deadline < now` rule).
    if (deadline < now) throw invalidField('deadline', 'TOO_SMALL', REOPEN_DEADLINE_PAST);
    // The schedule every other deadline write keeps: a project closed while still UPCOMING may
    // start recruiting later than the new deadline.
    if (project.recruitmentStartDate) validateRecruitmentSchedule(project.recruitmentStartDate, deadline);
  }

  return prisma.$transaction(async (tx) => {
    if (reopening) {
      // Lock the project row so the contract check and the reopen see the same state, as a
      // delete does. A contract awaiting signatures (or any contract that is not cancelled)
      // keeps recruitment closed: cancelling it first is the way out.
      const [locked] = await tx.$queryRaw<{ status: ProjectStatus }[]>`
        SELECT "status" FROM "Project" WHERE "id" = ${project.id} AND "deletedAt" IS NULL FOR UPDATE`;
      if (!locked) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
      if (locked.status !== 'CLOSED') throw new AppError('PROJECT_STATUS_TRANSITION_INVALID', `Cannot transition from ${locked.status} to ${status}`);
      const live = await tx.contract.findFirst({
        where: { projectId: project.id, status: { not: 'CANCELLED' } },
        select: { id: true },
      });
      if (live) throw new AppError('REOPEN_BLOCKED_BY_CONTRACT', REOPEN_WITH_CONTRACT);

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
      where: { id: projectId },
      data: { status },
    });

    if (status === 'CLOSED') {
      await rejectPendingApplicationsForClosedProjects({ projectId }, tx);
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
}
