import type { NextFunction, Request, Response } from 'express';
import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import openai from '../lib/openai';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { notifyMany } from '../lib/notifications/notify';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { expandSkillSearchTerms } from '../lib/skills';
import type { ProjectListQuery } from '../schemas/projects';
import type {
  AuthedRequest,
  PricingAnalysisData,
  ProjectStatusTransitions,
  RawPricingAnalysis,
} from '../types/index';

function validateRecruitmentSchedule(recruitmentStartDate: Date, deadline: Date) {
  if (recruitmentStartDate > deadline) {
    throw new AppError('recruitmentStartDate cannot be after deadline', 400);
  }
}

function parseAnalysisAmount(value: unknown) {
  const normalized = typeof value === 'string'
    ? value.replace(/[^\d.-]/g, '')
    : value;
  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.round(parsed);
}

/** A won amount in model prose: `11,000,000원`, `1100만 원`, `1.2억원`, `3천만원`. */
const WON_AMOUNT = /\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|만|천)?\s*원/;

/**
 * The model's summary without the sentences that state an amount. The model's own arithmetic
 * is not trusted (`totalAmount` is recomputed from the features), and a summary saying
 * "총 11,000,000원" under a recomputed total of 10,000,000원 contradicts the screen. Nothing
 * left → `null`.
 */
function summaryWithoutAmounts(value: unknown): string | null {
  if (!value) return null;
  const kept = String(value)
    .trim()
    .split(/(?<=[.!?。])\s+/)
    .filter((sentence) => !WON_AMOUNT.test(sentence))
    .join(' ')
    .trim();
  return kept || null;
}

function normalizePricingAnalysisData(data: RawPricingAnalysis): PricingAnalysisData {
  const features = (Array.isArray(data?.features) ? data.features : [])
    .map((feature, index) => ({
      name: String(feature?.name || `기능 ${index + 1}`).trim(),
      description: String(feature?.description || '').trim(),
      estimatedCost: parseAnalysisAmount(feature?.estimatedCost),
      rationale: String(feature?.rationale || '').trim(),
      duration: feature?.duration ? String(feature.duration).trim() : null,
    }))
    .filter((feature) => feature.estimatedCost > 0);

  if (features.length === 0) {
    throw new AppError('AI analysis did not return valid feature pricing', 502);
  }

  return {
    features,
    totalAmount: features.reduce((sum, feature) => sum + feature.estimatedCost, 0),
    summary: summaryWithoutAmounts(data?.summary),
    marketReference: data?.marketReference ? String(data.marketReference).trim() : null,
  };
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
        pricingAnalysis: true,
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

/** The live project a bookmark route acts on; a missing or soft-deleted project is 404. */
async function findBookmarkableProject(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
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

const validTransitions: ProjectStatusTransitions = {
  UPCOMING: ['OPEN', 'CANCELLED', 'CLOSED'],
  OPEN: ['CANCELLED', 'CLOSED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
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

export async function analyzeProject(req: AuthedRequest, res: Response, next: NextFunction) {
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

    const prompt = `
다음 프로젝트 정보를 분석하여 단위 기능별 예상 단가를 산정해주세요.

프로젝트명: ${project.title}
카테고리: ${project.category}
설명: ${project.description}
필요 기술: ${project.requiredSkills.join(', ')}
마감일: ${new Date(project.deadline).toLocaleDateString('ko-KR')}

클라이언트가 입력한 희망 예산은 제공하지 않습니다.
기존 예산이나 임의의 목표 금액에 맞추지 말고, 프로젝트 범위, 기능, 기술 난이도, 예상 작업량을 기준으로 독립적인 시장 적정가를 산정하세요.
각 기능별 estimatedCost의 합계가 totalAmount와 반드시 일치해야 합니다.
summary에는 금액을 쓰지 마세요. 총액은 기능별 금액의 합계로 화면에 따로 표시됩니다.
marketReference에는 유사 프로젝트의 시장 가격대만 쓰고, 이 프로젝트의 총액은 쓰지 마세요.
summary, marketReference, rationale은 '~합니다' 체의 완결된 문장으로 쓰세요.

다음 JSON 형식으로만 응답해주세요:
{
  "features": [
    {
      "name": "기능명",
      "description": "기능 설명",
      "estimatedCost": 숫자(원),
      "rationale": "산정 근거",
      "duration": "예상 기간(예: 3일, 1주)"
    }
  ],
  "totalAmount": 전체합계숫자(원),
  "summary": "전체 프로젝트 분석 요약",
  "marketReference": "유사 프로젝트 시장 참고 정보"
}
`;

    // A provider failure is an external-service error (502), not a bug (500): the cause goes to a
    // `warn` line and the response carries a generic message, never the provider's own text.
    let completion: Awaited<ReturnType<typeof openai.chat.completions.create>>;
    try {
      completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '당신은 한국 프리랜서 시장 전문가입니다. 프로젝트 단가를 정확하게 분석합니다. JSON 형식으로만 응답하세요.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });
    } catch (err) {
      logger.warn('ai analysis provider request failed', { projectId: project.id, err });
      throw new AppError('AI analysis provider request failed', 502);
    }

    const content = completion.choices?.[0]?.message?.content;

    if (!content) {
      logger.warn('ai analysis returned no content', { projectId: project.id });
      throw new AppError('AI analysis did not return a response', 502);
    }

    let parsed: RawPricingAnalysis;
    try {
      parsed = JSON.parse(content) as RawPricingAnalysis;
    } catch (err) {
      logger.warn('ai analysis returned invalid JSON', { projectId: project.id, err });
      throw new AppError('AI analysis did not return valid feature pricing', 502);
    }

    const analysisData = normalizePricingAnalysisData(parsed);
    // `PricingAnalysis.features` is a Json column; the normalized rows are plain JSON.
    const features: Prisma.InputJsonValue = analysisData.features;

    const analysis = await prisma.pricingAnalysis.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        features,
        totalAmount: analysisData.totalAmount,
        summary: analysisData.summary,
        marketReference: analysisData.marketReference,
      },
      update: {
        features,
        totalAmount: analysisData.totalAmount,
        summary: analysisData.summary,
        marketReference: analysisData.marketReference,
      },
    });

    res.json(analysis);
  } catch (err) {
    next(err);
  }
}
