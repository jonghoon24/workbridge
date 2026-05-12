import prisma from '../lib/prisma.js';
import openai from '../lib/openai.js';
import { AppError } from '../lib/errors.js';
import {
  closeExpiredOpenProjects,
  getProjectStatusForRecruitmentStart,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle.js';
import {
  expandSkillSearchTerms,
  normalizeSkillList,
} from '../lib/skills.js';

function parsePositiveInt(value, field, max = null) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(`${field} must be a positive integer`, 400);
  }
  return max ? Math.min(parsed, max) : parsed;
}

function parseBudget(value, field) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(`${field} must be a non-negative number`, 400);
  }
  return parsed;
}

function parseProjectDate(value, field) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400);
  }
  return parsed;
}

function validateRecruitmentSchedule(recruitmentStartDate, deadline) {
  if (recruitmentStartDate > deadline) {
    throw new AppError('recruitmentStartDate cannot be after deadline', 400);
  }
}

export async function getProjects(req, res, next) {
  try {
    await closeExpiredOpenProjects();

    const {
      search,
      category,
      minBudget,
      maxBudget,
      skills,
      status = 'OPEN',
      sort = 'latest',
      page = 1,
      limit = 10,
    } = req.query;
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

    const where = {
      deletedAt: null,
    };

    if (status !== 'ALL') {
      where.status = status;
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

    const orderBy = sort === 'deadline'
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

export async function createProject(req, res, next) {
  try {
    const { title, description, category, budget, recruitmentStartDate, deadline, requiredSkills } = req.body;

    if (!title || !description || !category || !budget || !deadline) {
      throw new AppError('All fields are required', 400);
    }

    const parsedDeadline = parseProjectDate(deadline, 'deadline');
    const parsedRecruitmentStartDate = recruitmentStartDate
      ? parseProjectDate(recruitmentStartDate, 'recruitmentStartDate')
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

export async function getProjectById(req, res, next) {
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

export async function getProjectBookmark(req, res, next) {
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

export async function createProjectBookmark(req, res, next) {
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

export async function deleteProjectBookmark(req, res, next) {
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

export async function updateProject(req, res, next) {
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
    const updateData = {};

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
        ? parseProjectDate(deadline, 'deadline')
        : project.deadline;
      const parsedRecruitmentStartDate = recruitmentStartDate !== undefined
        ? parseProjectDate(recruitmentStartDate, 'recruitmentStartDate')
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

export async function deleteProject(req, res, next) {
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

const validTransitions = {
  UPCOMING: ['OPEN', 'CANCELLED', 'CLOSED'],
  OPEN: ['CANCELLED', 'CLOSED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  CLOSED: [],
};

export async function updateProjectStatus(req, res, next) {
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
        await tx.notification.createMany({
          data: recipientIds.map((userId) => ({
            userId,
            type: 'PROJECT_STATUS_CHANGED',
            title: '프로젝트 모집이 마감되었습니다',
            message: `'${project.title}' 프로젝트 모집이 마감되었습니다.`,
            href: '/my/applications',
          })),
        });
      }

      return changedProject;
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function analyzeProject(req, res, next) {
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
예산: ${project.budget.toLocaleString()}원
필요 기술: ${project.requiredSkills.join(', ')}
마감일: ${new Date(project.deadline).toLocaleDateString('ko-KR')}

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

    const analysisData = JSON.parse(completion.choices[0].message.content);

    const analysis = await prisma.pricingAnalysis.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        features: analysisData.features,
        totalAmount: analysisData.totalAmount,
        summary: analysisData.summary,
        marketReference: analysisData.marketReference,
      },
      update: {
        features: analysisData.features,
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
