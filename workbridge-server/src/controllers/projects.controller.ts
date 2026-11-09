import type { NextFunction, Request, Response } from 'express';
import type { Prisma, ProjectStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import openai from '../lib/openai';
import { AppError } from '../lib/errors';
import { notifyMany } from '../lib/notifications/notify';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import {
  expandSkillSearchTerms,
  normalizeSkillList,
} from '../lib/skills';
import { kstDateToEndOfDay, startOfKstDay } from '../lib/time';
import type {
  AuthedRequest,
  PricingAnalysisData,
  ProjectStatusTransitions,
  RawPricingAnalysis,
} from '../types/index';

/**
 * `req.query` values are `string | string[] | ParsedQs | ParsedQs[] | undefined`.
 * Every filter below reads a single scalar, so collapse anything else to
 * `undefined` and let the caller fall back to its default.
 */
function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePositiveInt(value: string, field: string, max: number | null = null) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(`${field} must be a positive integer`, 400);
  }
  return max ? Math.min(parsed, max) : parsed;
}

function parseBudget(value: string, field: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(`${field} must be a non-negative number`, 400);
  }
  return parsed;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A project date from the request body. A bare `YYYY-MM-DD` (what the project form's date input
 * sends) is a **KST calendar day**: as a `deadline` it lasts until that day ends (23:59:59.999
 * KST), as a `recruitmentStartDate` it begins at 00:00 KST. `new Date('YYYY-MM-DD')` would read
 * it as 00:00 UTC = 09:00 KST, closing a project due "today" the moment it is created after 9 am.
 * Anything else must parse as an instant.
 */
function parseProjectDate(value: string, field: string, dateOnlyAs: 'startOfDay' | 'endOfDay') {
  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    let endOfDay: Date;
    try {
      endOfDay = kstDateToEndOfDay(value);
    } catch {
      throw new AppError(`${field} must be a valid date`, 400);
    }
    return dateOnlyAs === 'endOfDay' ? endOfDay : startOfKstDay(endOfDay);
  }

  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400);
  }
  return parsed;
}

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

export async function getProjects(req: Request, res: Response, next: NextFunction) {
  try {
    await closeExpiredOpenProjects();

    const search = queryString(req.query.search);
    const category = queryString(req.query.category);
    const minBudget = queryString(req.query.minBudget);
    const maxBudget = queryString(req.query.maxBudget);
    const skills = req.query.skills;
    const status = queryString(req.query.status) ?? 'OPEN';
    const sort = queryString(req.query.sort) ?? 'latest';
    const page = queryString(req.query.page) ?? '1';
    const limit = queryString(req.query.limit) ?? '10';
    const validSorts = ['latest', 'deadline', 'budget'];
    const validStatuses = ['ALL', 'UPCOMING', 'OPEN', 'CLOSED'];

    if (!validSorts.includes(sort)) {
      throw new AppError('sort must be latest, deadline, or budget', 400);
    }

    if (!validStatuses.includes(status)) {
      throw new AppError('status must be ALL, UPCOMING, OPEN, or CLOSED', 400);
    }

    const pageNum = parsePositiveInt(page, 'page');
    const limitNum = parsePositiveInt(limit, 'limit', 50);
    const minBudgetNum = minBudget ? parseBudget(minBudget, 'minBudget') : null;
    const maxBudgetNum = maxBudget ? parseBudget(maxBudget, 'maxBudget') : null;

    if (minBudgetNum !== null && maxBudgetNum !== null && minBudgetNum > maxBudgetNum) {
      throw new AppError('minBudget cannot be greater than maxBudget', 400);
    }

    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
    };

    if (status !== 'ALL') {
      // Validated against `validStatuses` above, and 'ALL' is excluded here, so the
      // remaining values are exactly ProjectStatus members.
      where.status = status as ProjectStatus;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) where.category = category;
    if (minBudgetNum !== null || maxBudgetNum !== null) {
      where.budget = {};
      if (minBudgetNum !== null) where.budget.gte = minBudgetNum;
      if (maxBudgetNum !== null) where.budget.lte = maxBudgetNum;
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
    const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = req.body;

    if (!title || !description || !category || !budget || !deadline) {
      throw new AppError('All fields are required', 400);
    }

    const parsedDeadline = parseProjectDate(deadline, 'deadline', 'endOfDay');
    const parsedRecruitmentStartDate = recruitmentStartDate
      ? parseProjectDate(recruitmentStartDate, 'recruitmentStartDate', 'startOfDay')
      : new Date();
    const parsedBudget = parseBudget(budget, 'budget');
    validateRecruitmentSchedule(parsedRecruitmentStartDate, parsedDeadline);

    const project = await prisma.project.create({
      data: {
        title,
        description,
        category,
        budget: parsedBudget,
        recruitmentStartDate: parsedRecruitmentStartDate,
        deadline: parsedDeadline,
        requiredSkills: normalizeSkillList(requiredSkills),
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
      where: { id: req.params.id, deletedAt: null },
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

export async function getProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
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
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new AppError('Project not found', 404);
    }

    await prisma.projectBookmark.upsert({
      where: {
        projectId_userId: {
          projectId: req.params.id,
          userId: req.user.id,
        },
      },
      update: {},
      create: {
        projectId: req.params.id,
        userId: req.user.id,
      },
    });

    res.status(201).json({ bookmarked: true });
  } catch (err) {
    next(err);
  }
}

export async function deleteProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
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

    const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = req.body;
    const updateData: Prisma.ProjectUpdateInput = {};

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (requiredSkills !== undefined) updateData.requiredSkills = normalizeSkillList(requiredSkills);

    // Restrict pricing and recruitment schedule changes if applications exist.
    if (project._count.applications > 0) {
      if (budget !== undefined || recruitmentStartDate !== undefined || deadline !== undefined) {
        throw new AppError('Cannot change budget or recruitment dates after applications have been submitted', 400);
      }
    } else {
      if (budget !== undefined) updateData.budget = parseBudget(budget, 'budget');

      const parsedDeadline = deadline !== undefined
        ? parseProjectDate(deadline, 'deadline', 'endOfDay')
        : project.deadline;
      const parsedRecruitmentStartDate = recruitmentStartDate !== undefined
        ? parseProjectDate(recruitmentStartDate, 'recruitmentStartDate', 'startOfDay')
        : project.recruitmentStartDate || new Date();

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

    await prisma.project.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
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
    const { status } = req.body;

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
        // Inline wording (pre-existing type), routed through `notifyMany()` for preferences and
        // email (NC9).
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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '당신은 한국 프리랜서 시장 전문가입니다. 프로젝트 단가를 정확하게 분석합니다. JSON 형식으로만 응답하세요.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = completion.choices[0].message.content;

    if (!content) {
      throw new AppError('AI analysis did not return a response', 502);
    }

    const analysisData = normalizePricingAnalysisData(
      JSON.parse(content) as RawPricingAnalysis,
    );
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
