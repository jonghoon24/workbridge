import type { Prisma, ProjectStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeContract,
  makeFreelancer,
  makeProject,
} from './helpers/factories';
import { DAY_MS, kstDateString, kstDateToEndOfDay, startOfKstDay } from '../src/lib/time';

/**
 * The project mutation endpoints. Product rules: `docs/domain/projects-contracts.md`.
 *
 * One module-boundary mock, and nothing else: `src/lib/projectLifecycle` — a passthrough by
 * default, switchable to throw so the `CLOSED` transaction's rollback can be observed (atomicity).
 *
 * Scope limit on that mock, worth stating because it is easy to over-read: replacing the
 * module's exports only intercepts calls made *through the module boundary*, i.e. the
 * controller's own `rejectPendingApplicationsForClosedProjects(...)` in `updateProjectStatus`.
 * `closeExpiredOpenProjects` reaches the same helper through a module-internal reference inside
 * `src/lib/projectLifecycle.ts`, which the mock cannot touch. So the fault injection below
 * exercises the rollback of the **`PATCH /:id/status` transaction only** — the lazy sweep's own
 * transaction is *not* covered anywhere in this file (another unit covers it).
 */

const lifecycleFault = vi.hoisted(() => ({ failRejectPending: false }));

vi.mock('../src/lib/projectLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/projectLifecycle')>();

  return {
    ...actual,
    rejectPendingApplicationsForClosedProjects: (
      ...args: Parameters<typeof actual.rejectPendingApplicationsForClosedProjects>
    ) => {
      if (lifecycleFault.failRejectPending) {
        return Promise.reject(new Error('injected rejectPendingApplications failure'));
      }
      return actual.rejectPendingApplicationsForClosedProjects(...args);
    },
  };
});

// --------------------------------------------------------------------------------------
// Local helpers (deliberately defined in this file rather than added to test/helpers)
// --------------------------------------------------------------------------------------

/** A complete-profile CLIENT plus one of their projects. */
async function ownedProject(overrides: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const client = await makeClient();
  const project = await makeProject(client.id, overrides);
  return { client, project };
}

const ALL_STATUSES: ProjectStatus[] = [
  'UPCOMING',
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'CLOSED',
];

/** `PATCH /:id/status` — the client's manual-transition table, verbatim. */
const ALLOWED: Array<[ProjectStatus, ProjectStatus]> = [
  ['UPCOMING', 'OPEN'],
  ['UPCOMING', 'CANCELLED'],
  ['UPCOMING', 'CLOSED'],
  ['OPEN', 'CANCELLED'],
  ['OPEN', 'CLOSED'],
];

/** Reopening takes a deadline and has its own conditions: its own `describe` below. */
const REOPEN: [ProjectStatus, ProjectStatus] = ['CLOSED', 'OPEN'];

const FORBIDDEN: Array<[ProjectStatus, ProjectStatus]> = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES
    .filter((to) => ![...ALLOWED, REOPEN].some(([f, t]) => f === from && t === to))
    .map((to) => [from, to] as [ProjectStatus, ProjectStatus]),
);

// ======================================================================================
// POST /api/projects
// ======================================================================================

describe('POST /api/projects', () => {
  const validBody = () => ({
    title: '랜딩 페이지 제작',
    description: '반응형 랜딩 페이지 한 장을 만들어 주세요.',
    category: '웹 개발',
    budget: 3_000_000,
    deadline: daysFromNow(30).toISOString(),
  });

  it.each([
    ['title', 'Project title is required'],
    ['description', 'Project description is required'],
    ['category', 'Category is required'],
    ['budget', 'Budget is required'],
    ['deadline', 'Deadline is required'],
  ])(
    'rejects a body missing %s with 400',
    async (field, message) => {
      const client = await makeClient();
      const body: Record<string, unknown> = validBody();
      delete body[field];

      const res = await authed(client).post('/api/projects').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: `${field}: ${message}` } });
      expect(await prisma.project.count()).toBe(0);
    },
  );

  it('rejects an unparseable deadline with 400', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), deadline: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('deadline: Deadline must be a valid date');
    expect(await prisma.project.count()).toBe(0);
  });

  it('rejects an unparseable recruitmentStartDate with 400', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), recruitmentStartDate: 'yesterday-ish' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('recruitmentStartDate: Recruitment start date must be a valid date');
    expect(await prisma.project.count()).toBe(0);
  });

  it('rejects a negative budget with 400', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('budget: Budget must be a positive whole number of won');
    expect(await prisma.project.count()).toBe(0);
  });

  it('rejects a non-numeric budget with 400, not a 500 from the database', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('budget: Budget must be a positive whole number of won');
    expect(await prisma.project.count()).toBe(0);
  });

  // Boundary: a budget is at least 1 won. `0` is refused like any other invalid budget.
  it('rejects a zero budget with 400', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'budget: Budget must be a positive whole number of won' } });
    expect(await prisma.project.count()).toBe(0);
  });

  it('accepts a budget of 1 won with 201 and persists it', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget: 1 });

    expect(res.status).toBe(201);
    expect(res.body.budget).toBe(1);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.budget).toBe(1);
  });

  it('accepts a numeric-string budget', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget: '2500000' });

    expect(res.status).toBe(201);
    expect(res.body.budget).toBe(2_500_000);
  });

  // Strict body validation: `parseFloat` used to accept these by truncating or reading them loosely.
  it.each([
    ['trailing garbage', '2500000abc'],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['Infinity', 'Infinity'],
    ['a boolean', true],
    ['null', null],
    // Money-time rule: amounts are whole won.
    ['a fraction', 2_500_000.5],
    ['a fractional string', '1000.5'],
  ])('rejects %s as budget with 400', async (_label, budget) => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), budget });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'budget: Budget must be a positive whole number of won' } });
    expect(await prisma.project.count()).toBe(0);
  });

  it.each([
    ['title', 'Project title is required'],
    ['description', 'Project description is required'],
    ['category', 'Category is required'],
  ])('rejects a whitespace-only %s with 400', async (field, message) => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), [field]: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: `${field}: ${message}` } });
    expect(await prisma.project.count()).toBe(0);
  });

  // A non-string title used to be passed to Prisma, which rejected it as a 500.
  it('rejects a non-string title with 400 rather than 500', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), title: 123 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'title: Project title must be a string' } });
    expect(await prisma.project.count()).toBe(0);
  });

  it('trims the text fields', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), title: '  랜딩 페이지  ', category: ' 웹 개발 ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: '랜딩 페이지', category: '웹 개발' });
  });

  it('rejects a non-string deadline with 400', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), deadline: 1_900_000_000_000 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'deadline: Deadline must be a valid date' } });
  });

  it.each([
    ['an empty string', ''],
    ['null', null],
  ])('treats %s as an absent recruitmentStartDate, defaulting to now', async (_label, recruitmentStartDate) => {
    const client = await makeClient();
    const before = Date.now();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), recruitmentStartDate });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(new Date(res.body.recruitmentStartDate).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects recruitmentStartDate after deadline with 400', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({
      ...validBody(),
      recruitmentStartDate: daysFromNow(40).toISOString(),
      deadline: daysFromNow(30).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('recruitmentStartDate cannot be after deadline');
    expect(await prisma.project.count()).toBe(0);
  });

  it('accepts recruitmentStartDate exactly equal to deadline (boundary)', async () => {
    const client = await makeClient();
    const sameInstant = daysFromNow(20).toISOString();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), recruitmentStartDate: sameInstant, deadline: sameInstant });

    expect(res.status).toBe(201);
    expect(res.body.recruitmentStartDate).toBe(res.body.deadline);
  });

  it('derives UPCOMING when recruitment starts in the future', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), recruitmentStartDate: daysFromNow(7).toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('UPCOMING');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.status).toBe('UPCOMING');
  });

  it('derives OPEN when recruitment already started', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), recruitmentStartDate: daysFromNow(-2).toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.status).toBe('OPEN');
  });

  it('derives OPEN and defaults recruitmentStartDate to now when it is omitted', async () => {
    const client = await makeClient();
    const before = Date.now();

    const res = await authed(client).post('/api/projects').send(validBody());
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.recruitmentStartDate).not.toBeNull();
    // Bracketed by timestamps taken immediately either side of the request, with a wide slack.
    // The default is `new Date()` inside the handler, so the true window is `[before, after]`;
    // the slack only absorbs clock coarseness. It was ±1s, which is thin enough to flake on a
    // loaded machine or a cold Prisma engine start, and 30s still rules out every wrong default
    // that matters (epoch, null, the deadline 30 days out).
    expect(stored.recruitmentStartDate!.getTime()).toBeGreaterThanOrEqual(before - 30_000);
    expect(stored.recruitmentStartDate!.getTime()).toBeLessThanOrEqual(after + 30_000);
  });

  describe('date-only values are KST calendar days', () => {
    it('a deadline of today lasts until 23:59:59.999 KST, so the project stays OPEN', async () => {
      const client = await makeClient();
      const today = kstDateString(new Date());

      const res = await authed(client).post('/api/projects').send({ ...validBody(), deadline: today });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.deadline).toBe(kstDateToEndOfDay(today).toISOString());
      // The next read runs the lifecycle sweep; the project must survive it.
      const read = await api().get(`/api/projects/${res.body.id}`);
      expect(read.body.status).toBe('OPEN');
    });

    it('a recruitmentStartDate of today begins at 00:00 KST, so the project is OPEN at once', async () => {
      const client = await makeClient();
      const now = new Date();
      const today = kstDateString(now);

      const res = await authed(client)
        .post('/api/projects')
        .send({ ...validBody(), recruitmentStartDate: today, deadline: today });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.recruitmentStartDate).toBe(startOfKstDay(now).toISOString());
    });

    it('a recruitmentStartDate of a later day begins at that day\'s 00:00 KST, so the project is UPCOMING', async () => {
      const client = await makeClient();
      const startDay = kstDateString(new Date(Date.now() + 3 * DAY_MS));

      const res = await authed(client)
        .post('/api/projects')
        .send({ ...validBody(), recruitmentStartDate: startDay });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('UPCOMING');
      expect(res.body.recruitmentStartDate).toBe(startOfKstDay(kstDateToEndOfDay(startDay)).toISOString());
    });

    it('rejects a date-only value that is not a calendar date with 400', async () => {
      const client = await makeClient();

      const res = await authed(client).post('/api/projects').send({ ...validBody(), deadline: '2030-02-30' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'deadline: Deadline must be a valid date' } });
      expect(await prisma.project.count()).toBe(0);
    });
  });

  it('normalizes and de-duplicates requiredSkills', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), requiredSkills: ['PostgreSQL', 'MySQL', ' React ', 'React'] });

    expect(res.status).toBe(201);
    expect(res.body.requiredSkills).toEqual(['SQL', 'React']);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.requiredSkills).toEqual(['SQL', 'React']);
  });

  it('accepts requiredSkills as a comma-separated string', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), requiredSkills: 'React, PostgreSQL' });

    expect(res.status).toBe(201);
    expect(res.body.requiredSkills).toEqual(['React', 'SQL']);
  });

  // A malformed value is a 400, never a 500. `normalizeSkillList` calls
  // `.trim()` on every element, so a numeric array used to throw a `TypeError` → 500;
  // `projectCreateBody` admits only a string or a list of strings.
  it.each([
    ['a numeric array', [1, 2]],
    ['a nested array', [['React']]],
    ['a number', 7],
    ['an object', { React: true }],
  ])('rejects %s as requiredSkills with 400 and creates nothing', async (_label, requiredSkills) => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/projects')
      .send({ ...validBody(), requiredSkills });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'requiredSkills: Required skills must be a string or a list of strings' } });
    expect(await prisma.project.count()).toBe(0);
  });

  it('yields [] when requiredSkills is null', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send({ ...validBody(), requiredSkills: null });

    expect(res.status).toBe(201);
    expect(res.body.requiredSkills).toEqual([]);
  });

  it('yields [] when requiredSkills is omitted', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/projects').send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.requiredSkills).toEqual([]);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.requiredSkills).toEqual([]);
  });

  it('takes clientId from the token and ignores a clientId in the body', async () => {
    const owner = await makeClient();
    const other = await makeClient();

    const res = await authed(owner)
      .post('/api/projects')
      .send({ ...validBody(), clientId: other.id });

    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(owner.id);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.clientId).toBe(owner.id);
  });

  it('responds 201 with the created project and persists it', async () => {
    const client = await makeClient();
    const body = { ...validBody(), requiredSkills: ['React'] };

    const res = await authed(client).post('/api/projects').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      title: body.title,
      description: body.description,
      category: body.category,
      budget: body.budget,
      requiredSkills: ['React'],
      status: 'OPEN',
      clientId: client.id,
      deletedAt: null,
    });
    expect(new Date(res.body.deadline).toISOString()).toBe(body.deadline);
    expect(res.body).not.toHaveProperty('client');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.title).toBe(body.title);
    expect(stored.budget).toBe(body.budget);
    expect(stored.deadline.toISOString()).toBe(body.deadline);
  });
});

// ======================================================================================
// GET /api/projects/:id
// ======================================================================================

describe('GET /api/projects/:id', () => {
  it('returns the project with its client and application count', async () => {
    const { client, project } = await ownedProject();
    const freelancerA = await makeFreelancer();
    const freelancerB = await makeFreelancer();
    await makeApplication(project.id, freelancerA.id);
    await makeApplication(project.id, freelancerB.id);

    const res = await api().get(`/api/projects/${project.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: project.id,
      title: project.title,
      client: {
        id: client.id,
        name: client.name,
        companyName: client.companyName,
        businessField: client.businessField,
      },
      _count: { applications: 2 },
    });
    expect(res.body.client).not.toHaveProperty('email');
  });

  it('counts zero applications for a project nobody applied to', async () => {
    const { project } = await ownedProject();

    const res = await api().get(`/api/projects/${project.id}`);

    expect(res.status).toBe(200);
    expect(res.body._count.applications).toBe(0);
  });

  it('writes rows: the lifecycle sweep promotes UPCOMING to OPEN on read', async () => {
    const { project } = await ownedProject({
      status: 'UPCOMING',
      recruitmentStartDate: daysFromNow(-1),
      deadline: daysFromNow(10),
    });

    const res = await api().get(`/api/projects/${project.id}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
  });

  it('writes rows: the sweep closes an expired project and rejects its pending applications', async () => {
    const { project } = await ownedProject({
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const freelancer = await makeFreelancer();
    const application = await makeApplication(project.id, freelancer.id);

    const res = await api().get(`/api/projects/${project.id}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');

    const storedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(storedProject.status).toBe('CLOSED');
    const storedApplication = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(storedApplication.status).toBe('REJECTED');
  });
});

// ======================================================================================
// PATCH /api/projects/:id
// ======================================================================================

describe('PATCH /api/projects/:id', () => {
  it('edits title, description, category and requiredSkills', async () => {
    const { client, project } = await ownedProject();

    const res = await authed(client).patch(`/api/projects/${project.id}`).send({
      title: '수정된 제목',
      description: '수정된 설명',
      category: '모바일 앱',
      requiredSkills: ['PostgreSQL', 'React'],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: '수정된 제목',
      description: '수정된 설명',
      category: '모바일 앱',
      requiredSkills: ['SQL', 'React'],
    });

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.title).toBe('수정된 제목');
    expect(stored.description).toBe('수정된 설명');
    expect(stored.category).toBe('모바일 앱');
    expect(stored.requiredSkills).toEqual(['SQL', 'React']);
  });

  // Same check as on `POST` (it used to be a `TypeError` → 500). The whole update is
  // refused, so neither the skills nor the title sent alongside them is modified.
  it('rejects a non-string requiredSkills array with 400 and modifies nothing', async () => {
    const { client, project } = await ownedProject();

    const res = await authed(client)
      .patch(`/api/projects/${project.id}`)
      .send({ title: '함께 보낸 제목', requiredSkills: [1, 2] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'requiredSkills: Required skills must be a string or a list of strings' } });

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.requiredSkills).toEqual(project.requiredSkills);
    expect(stored.title).toBe(project.title);
  });

  // `title !== undefined` used to store an empty title, and a `null` one reached Prisma as a 500.
  it.each([
    ['an empty title', { title: '' }, 'title: Project title is required'],
    ['a whitespace-only description', { description: '  ' }, 'description: Project description is required'],
    ['a null category', { category: null }, 'category: Category must be a string'],
    ['a null deadline', { deadline: null }, 'deadline: Deadline must be a valid date'],
    ['an empty recruitmentStartDate', { recruitmentStartDate: '' }, 'recruitmentStartDate: Recruitment start date must be a valid date'],
  ])('rejects %s with 400 and modifies nothing', async (_label, body, message) => {
    const { client, project } = await ownedProject();

    const res = await authed(client).patch(`/api/projects/${project.id}`).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored).toEqual(project);
  });

  it('clears requiredSkills when it is sent as null', async () => {
    const { client, project } = await ownedProject();

    const res = await authed(client).patch(`/api/projects/${project.id}`).send({ requiredSkills: null });

    expect(res.status).toBe(200);
    expect(res.body.requiredSkills).toEqual([]);
  });

  // Validation runs before the controller's 404/403.
  it('validates the body before the ownership check: an invalid body from a non-owner is 400', async () => {
    const { project } = await ownedProject();
    const intruder = await makeClient();

    const res = await authed(intruder).patch(`/api/projects/${project.id}`).send({ budget: -1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'budget: Budget must be a positive whole number of won' } });
  });

  it('leaves omitted fields untouched', async () => {
    const { client, project } = await ownedProject();

    const res = await authed(client).patch(`/api/projects/${project.id}`).send({ title: '제목만' });

    expect(res.status).toBe(200);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.title).toBe('제목만');
    expect(stored.description).toBe(project.description);
    expect(stored.budget).toBe(project.budget);
    expect(stored.deadline.toISOString()).toBe(project.deadline.toISOString());
    expect(stored.requiredSkills).toEqual(project.requiredSkills);
  });

  it('ignores status in the body — status only changes through PATCH /:id/status', async () => {
    const { client, project } = await ownedProject({ status: 'OPEN' });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}`)
      .send({ title: 'still open', status: 'CANCELLED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
  });

  it('ignores clientId in the body — ownership cannot be transferred', async () => {
    const { client, project } = await ownedProject();
    const other = await makeClient();

    const res = await authed(client)
      .patch(`/api/projects/${project.id}`)
      .send({ title: 'mine', clientId: other.id });

    expect(res.status).toBe(200);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.clientId).toBe(client.id);
  });

  describe('with at least one application, terms are frozen', () => {
    async function projectWithApplication() {
      const { client, project } = await ownedProject();
      const freelancer = await makeFreelancer();
      await makeApplication(project.id, freelancer.id);
      return { client, project };
    }

    const frozenMessage =
      'Cannot change budget or recruitment dates after applications have been submitted';

    it('refuses a budget change with 400', async () => {
      const { client, project } = await projectWithApplication();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ budget: 9_999_999 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: frozenMessage } });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.budget).toBe(project.budget);
    });

    it('refuses a recruitmentStartDate change with 400', async () => {
      const { client, project } = await projectWithApplication();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ recruitmentStartDate: daysFromNow(3).toISOString() });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: frozenMessage } });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.recruitmentStartDate?.toISOString()).toBe(
        project.recruitmentStartDate?.toISOString(),
      );
    });

    it('refuses a deadline change with 400', async () => {
      const { client, project } = await projectWithApplication();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ deadline: daysFromNow(90).toISOString() });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: frozenMessage } });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.deadline.toISOString()).toBe(project.deadline.toISOString());
    });

    it('refuses a frozen field even when sent alongside editable ones, saving nothing', async () => {
      const { client, project } = await projectWithApplication();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ title: '같이 보냄', budget: 1 });

      expect(res.status).toBe(400);

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.title).toBe(project.title);
      expect(stored.budget).toBe(project.budget);
    });

    it('still allows title, description, category and requiredSkills', async () => {
      const { client, project } = await projectWithApplication();

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({
        title: '지원자 있어도 수정 가능',
        description: '설명 수정',
        category: '데이터',
        requiredSkills: ['MySQL'],
      });

      expect(res.status).toBe(200);

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.title).toBe('지원자 있어도 수정 가능');
      expect(stored.description).toBe('설명 수정');
      expect(stored.category).toBe('데이터');
      expect(stored.requiredSkills).toEqual(['SQL']);
    });
  });

  describe('with no applications, dates re-validate and the status is recomputed', () => {
    it('rejects a deadline that lands before the existing recruitmentStartDate with 400', async () => {
      const { client, project } = await ownedProject({
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(10),
        deadline: daysFromNow(30),
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ deadline: daysFromNow(2).toISOString() });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { message: 'recruitmentStartDate cannot be after deadline' },
      });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.deadline.toISOString()).toBe(project.deadline.toISOString());
    });

    it('rejects a recruitmentStartDate after the existing deadline with 400', async () => {
      const { client, project } = await ownedProject({ deadline: daysFromNow(30) });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ recruitmentStartDate: daysFromNow(60).toISOString() });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('recruitmentStartDate cannot be after deadline');
    });

    it('rejects an unparseable deadline with 400', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ deadline: 'someday' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('deadline: Deadline must be a valid date');
    });

    it('rejects a negative budget with 400', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({ budget: -5 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('budget: Budget must be a positive whole number of won');

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.budget).toBe(project.budget);
    });

    it('rejects a non-numeric budget with 400, not a 500 from the database', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({ budget: 'abc' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('budget: Budget must be a positive whole number of won');
    });

    // The `PATCH` counterpart of the budget boundary on `POST`: at least 1 won.
    it('rejects a zero budget with 400 and keeps the stored budget', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({ budget: 0 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'budget: Budget must be a positive whole number of won' } });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.budget).toBe(project.budget);
    });

    it('accepts a budget of 1 won and persists it', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({ budget: 1 });

      expect(res.status).toBe(200);
      expect(res.body.budget).toBe(1);

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.budget).toBe(1);
    });

    it('updates the budget when it is valid', async () => {
      const { client, project } = await ownedProject();

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ budget: 1_234_000 });

      expect(res.status).toBe(200);
      expect(res.body.budget).toBe(1_234_000);

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.budget).toBe(1_234_000);
    });

    it('reads a date-only deadline as the end of that KST day, so moving it to today keeps the project OPEN', async () => {
      const { client, project } = await ownedProject({
        status: 'OPEN',
        recruitmentStartDate: daysFromNow(-1),
        deadline: daysFromNow(30),
      });
      const today = kstDateString(new Date());

      const res = await authed(client).patch(`/api/projects/${project.id}`).send({ deadline: today });

      expect(res.status).toBe(200);
      expect(res.body.deadline).toBe(kstDateToEndOfDay(today).toISOString());
      expect((await api().get(`/api/projects/${project.id}`)).body.status).toBe('OPEN');
    });

    it('recomputes OPEN -> UPCOMING when recruitment is pushed into the future', async () => {
      const { client, project } = await ownedProject({
        status: 'OPEN',
        recruitmentStartDate: daysFromNow(-1),
        deadline: daysFromNow(30),
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ recruitmentStartDate: daysFromNow(5).toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UPCOMING');

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.status).toBe('UPCOMING');
    });

    it('recomputes UPCOMING -> OPEN when recruitment is pulled into the past', async () => {
      const { client, project } = await ownedProject({
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(5),
        deadline: daysFromNow(30),
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ recruitmentStartDate: daysFromNow(-1).toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OPEN');

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.status).toBe('OPEN');
    });

    // `getProjectStatusForRecruitmentStart` only ever answers UPCOMING or OPEN, so moving the
    // deadline into the past does not close the project on the spot — the lazy lifecycle sweep
    // converges it on the next read. Only the converged state is asserted.
    it('converges to CLOSED on the next read when the deadline is moved into the past', async () => {
      const { client, project } = await ownedProject({
        status: 'OPEN',
        recruitmentStartDate: daysFromNow(-10),
        deadline: daysFromNow(30),
      });

      const patched = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ deadline: daysFromNow(-1).toISOString() });
      expect(patched.status).toBe(200);

      const read = await api().get(`/api/projects/${project.id}`);
      expect(read.status).toBe(200);
      expect(read.body.status).toBe('CLOSED');

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.status).toBe('CLOSED');
    });

    it('does not touch the status when only non-schedule fields change', async () => {
      const { client, project } = await ownedProject({
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(5),
        deadline: daysFromNow(30),
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ title: '제목만', budget: 100 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UPCOMING');
    });

    it('does not recompute the status of a project that is neither UPCOMING nor OPEN', async () => {
      const { client, project } = await ownedProject({
        status: 'CANCELLED',
        recruitmentStartDate: daysFromNow(-5),
        deadline: daysFromNow(30),
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}`)
        .send({ recruitmentStartDate: daysFromNow(5).toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.recruitmentStartDate?.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('allows editing a COMPLETED project — intentional', async () => {
    const { client, project } = await ownedProject({ status: 'COMPLETED' });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}`)
      .send({ title: '완료 후 수정', requiredSkills: ['MySQL'] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.title).toBe('완료 후 수정');
    expect(stored.requiredSkills).toEqual(['SQL']);
    expect(stored.status).toBe('COMPLETED');
  });

  it('allows editing a CANCELLED project — intentional', async () => {
    const { client, project } = await ownedProject({ status: 'CANCELLED' });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}`)
      .send({ description: '취소 후 수정' });

    expect(res.status).toBe(200);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.description).toBe('취소 후 수정');
  });
});

// ======================================================================================
// DELETE /api/projects/:id
// ======================================================================================

describe('PATCH /api/projects/:id/status — reopening (CLOSED -> OPEN)', () => {
  /** A CLOSED project of a client, with a contract in `contractStatus` (if any) on an accepted application. */
  async function closedProject(contractStatus?: 'PENDING' | 'CANCELLED') {
    const { client, project } = await ownedProject({ status: 'CLOSED', deadline: daysFromNow(-1) });
    if (contractStatus) {
      const freelancer = await makeFreelancer();
      const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
      await makeContract(
        { projectId: project.id, applicationId: application.id, clientId: client.id, freelancerId: freelancer.id },
        { status: contractStatus },
      );
    }
    return { client, project };
  }

  const futureDate = () => kstDateString(new Date(Date.now() + 14 * DAY_MS));

  it('reopens a project whose contract was cancelled, with the new deadline (end of that KST day)', async () => {
    const { client, project } = await closedProject('CANCELLED');
    const deadline = futureDate();

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
    expect(stored.deadline).toEqual(kstDateToEndOfDay(deadline));
    expect(await prisma.notification.count()).toBe(0);
  });

  it('reopens a project that closed without any contract', async () => {
    const { client, project } = await closedProject();

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: futureDate() });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');
  });

  it('accepts today (KST) as the new deadline: recruitment lasts until the day ends', async () => {
    const { client, project } = await closedProject('CANCELLED');
    const today = kstDateString(new Date());

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: today });

    expect(res.status).toBe(200);
    // The lifecycle sweep that a later read runs leaves it open.
    const list = await api().get(`/api/projects/${project.id}`);
    expect(list.body.status).toBe('OPEN');
  });

  it('refuses without a deadline with 400 and changes nothing', async () => {
    const { client, project } = await closedProject('CANCELLED');

    const res = await authed(client).patch(`/api/projects/${project.id}/status`).send({ status: 'OPEN' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Deadline is required to reopen recruitment' } });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('CLOSED');
  });

  it('refuses a deadline in the past with 400', async () => {
    const { client, project } = await closedProject('CANCELLED');

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: kstDateString(new Date(Date.now() - DAY_MS)) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Deadline must not be in the past' } });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('CLOSED');
  });

  it('refuses a deadline before the recruitment start date with 400 (closed while still upcoming)', async () => {
    const { client, project } = await ownedProject({
      status: 'CLOSED',
      recruitmentStartDate: new Date(Date.now() + 30 * DAY_MS),
      deadline: new Date(Date.now() + 40 * DAY_MS),
    });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: futureDate() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'recruitmentStartDate cannot be after deadline' } });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('CLOSED');
  });

  it('reopens a project closed before its recruitment started as UPCOMING', async () => {
    const { client, project } = await ownedProject({
      status: 'CLOSED',
      recruitmentStartDate: new Date(Date.now() + 3 * DAY_MS),
      deadline: new Date(Date.now() + 10 * DAY_MS),
    });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: futureDate() });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UPCOMING');
  });

  it('refuses an invalid deadline with the validation 400', async () => {
    const { client, project } = await closedProject('CANCELLED');

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: 'next week' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'deadline: Deadline must be a valid date' } });
  });

  it('refuses while a contract awaits signatures with 409, leaving the project and the deadline alone', async () => {
    const { client, project } = await closedProject('PENDING');

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'OPEN', deadline: futureDate() });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Cannot reopen recruitment while the project has a contract' } });
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('CLOSED');
    expect(stored.deadline).toEqual(project.deadline);
  });

  it('refuses a deadline on any other transition with 400', async () => {
    const { client, project } = await ownedProject({ status: 'OPEN' });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'CLOSED', deadline: futureDate() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Deadline can only be set when reopening recruitment' } });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('OPEN');
  });

  it('takes new applications once reopened', async () => {
    const { client, project } = await closedProject('CANCELLED');
    await authed(client).patch(`/api/projects/${project.id}/status`).send({ status: 'OPEN', deadline: futureDate() });
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).post(`/api/projects/${project.id}/applications`).send({
      coverLetter: '다시 모집한다고 해서 지원합니다.',
      expectedRate: 3_000_000,
      expectedDuration: '4주',
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
  });
});

describe('DELETE /api/projects/:id', () => {
  it('soft-deletes: sets deletedAt and keeps the row', async () => {
    const { client, project } = await ownedProject();

    const res = await authed(client).delete(`/api/projects/${project.id}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');

    const stored = await prisma.project.findUnique({ where: { id: project.id } });
    expect(stored).not.toBeNull();
    expect(stored!.deletedAt).toBeInstanceOf(Date);
    expect(await prisma.project.count()).toBe(1);
  });

  it('removes the project from the list and makes it 404 by id', async () => {
    const { client, project } = await ownedProject({ status: 'OPEN' });

    const before = await api().get('/api/projects');
    expect(before.body.projects.map((p: { id: string }) => p.id)).toContain(project.id);

    const del = await authed(client).delete(`/api/projects/${project.id}`);
    expect(del.status).toBe(200);

    const list = await api().get('/api/projects?status=ALL');
    expect(list.status).toBe(200);
    expect(list.body.projects).toEqual([]);
    expect(list.body.meta.total).toBe(0);

    const byId = await api().get(`/api/projects/${project.id}`);
    expect(byId.status).toBe(404);
  });

  it('keeps the applications of a soft-deleted project in the database', async () => {
    const { client, project } = await ownedProject();
    const freelancer = await makeFreelancer();
    const application = await makeApplication(project.id, freelancer.id);

    await authed(client).delete(`/api/projects/${project.id}`);

    const stored = await prisma.application.findUnique({ where: { id: application.id } });
    expect(stored).not.toBeNull();
  });

  // A completed or cancelled contract is the freelancer's record: deleting the project would make
  // their contract, its link in their notifications and its conversation all 404.
  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'refuses to delete a project whose contract is %s (the counterpart\'s record) and leaves it visible to the freelancer',
    async (status) => {
      const { client, freelancer, project, contract } = await projectWithContract(status);

      const res = await authed(client).delete(`/api/projects/${project.id}`);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { message: 'Cannot delete a project with a contract record' } });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).deletedAt).toBeNull();
      expect((await authed(freelancer).get(`/api/contracts/${contract.id}`)).status).toBe(200);
    },
  );

  it('reports an unfinished contract first when the project also has a cancelled one', async () => {
    const { client, project } = await projectWithContract('CANCELLED');
    const freelancer = await makeFreelancer();
    const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
    await makeContract(
      { projectId: project.id, applicationId: application.id, clientId: client.id, freelancerId: freelancer.id },
      { status: 'PENDING' },
    );

    const res = await authed(client).delete(`/api/projects/${project.id}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Cannot delete a project with an unfinished contract' } });
  });

  it.each(['PENDING', 'ACTIVE'] as const)(
    'refuses to delete a project whose contract is %s and leaves both untouched',
    async (status) => {
      const { client, project, contract } = await projectWithContract(status);

      const res = await authed(client).delete(`/api/projects/${project.id}`);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: { message: 'Cannot delete a project with an unfinished contract' },
      });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.deletedAt).toBeNull();
      const storedContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
      expect(storedContract.status).toBe(status);
    },
  );

  it('checks ownership before the contract: a stranger gets 403, not 409', async () => {
    const { project } = await projectWithContract('ACTIVE');
    const intruder = await makeClient();

    const res = await authed(intruder).delete(`/api/projects/${project.id}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });
  });

  async function projectWithContract(status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED') {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const project = await makeProject(client.id, { status: 'CLOSED' });
    const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
    const contract = await makeContract(
      {
        projectId: project.id,
        applicationId: application.id,
        clientId: client.id,
        freelancerId: freelancer.id,
      },
      { status },
    );

    return { client, freelancer, project, application, contract };
  }
});

// ======================================================================================
// PATCH /api/projects/:id/status
// ======================================================================================

describe('PATCH /api/projects/:id/status', () => {
  it('returns 404 for an unknown id', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .patch('/api/projects/00000000-0000-0000-0000-000000000000/status')
      .send({ status: 'CLOSED' });

    expect(res.status).toBe(404);
  });

  it('returns 403 Not authorized for a client who does not own the project', async () => {
    const { project } = await ownedProject();
    const intruder = await makeClient();

    const res = await authed(intruder)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
  });

  it('returns 400 when status is missing from the body', async () => {
    const { client, project } = await ownedProject({ status: 'OPEN' });

    const res = await authed(client).patch(`/api/projects/${project.id}/status`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('status: Project status is required');

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
  });

  it('returns 400 for a value outside the ProjectStatus enum', async () => {
    const { client, project } = await ownedProject({ status: 'OPEN' });

    const res = await authed(client)
      .patch(`/api/projects/${project.id}/status`)
      .send({ status: 'BANANA' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'status: Project status must be one of UPCOMING, OPEN, IN_PROGRESS, COMPLETED, CANCELLED, CLOSED',
    );

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe('OPEN');
  });

  // Validation runs before the controller's 404.
  it('validates the body before the existence check: an invalid status on an unknown id is 400', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .patch('/api/projects/00000000-0000-0000-0000-000000000000/status')
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^status: Project status must be one of /);
  });

  it.each(ALLOWED)('allows %s -> %s', async (from, to) => {
    const { client, project } = await ownedProject({ status: from });

    const res = await authed(client).patch(`/api/projects/${project.id}/status`).send({ status: to });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(to);

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe(to);
  });

  it.each(FORBIDDEN)('refuses %s -> %s with 400', async (from, to) => {
    const { client, project } = await ownedProject({ status: from });

    const res = await authed(client).patch(`/api/projects/${project.id}/status`).send({ status: to });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: `Cannot transition from ${from} to ${to}` } });

    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.status).toBe(from);
  });

  describe('transitioning to CLOSED', () => {
    it('rejects still-PENDING applications and notifies each applicant once', async () => {
      const { client, project } = await ownedProject({ status: 'OPEN' });
      const freelancerA = await makeFreelancer();
      const freelancerB = await makeFreelancer();
      const applicationA = await makeApplication(project.id, freelancerA.id);
      const applicationB = await makeApplication(project.id, freelancerB.id);

      const res = await authed(client)
        .patch(`/api/projects/${project.id}/status`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CLOSED');

      const applications = await prisma.application.findMany({
        where: { id: { in: [applicationA.id, applicationB.id] } },
      });
      expect(applications.map((a) => a.status).sort()).toEqual(['REJECTED', 'REJECTED']);

      const notifications = await prisma.notification.findMany();
      expect(notifications).toHaveLength(2);
      expect(notifications.every((n) => n.type === 'PROJECT_STATUS_CHANGED')).toBe(true);
      expect(notifications.map((n) => n.userId).sort()).toEqual(
        [freelancerA.id, freelancerB.id].sort(),
      );
      expect(notifications[0].message).toContain(project.title);
    });

    it('notifies a freelancer who applied to two projects only for the project being closed', async () => {
      const client = await makeClient();
      const freelancer = await makeFreelancer();
      const closing = await makeProject(client.id, { status: 'OPEN' });
      const other = await makeProject(client.id, { status: 'OPEN' });
      const closingApplication = await makeApplication(closing.id, freelancer.id);
      const otherApplication = await makeApplication(other.id, freelancer.id);

      const res = await authed(client)
        .patch(`/api/projects/${closing.id}/status`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { userId: freelancer.id },
      });
      expect(notifications).toHaveLength(1);

      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: closingApplication.id } })).status,
      ).toBe('REJECTED');
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: otherApplication.id } })).status,
      ).toBe('PENDING');
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: other.id } })).status,
      ).toBe('OPEN');
    });

    // An applicant decided earlier was told then (or, rejected in a round that ended with a
    // cancelled contract, already knows): closing a reopened project must not tell them again.
    it('notifies only the applicants whose applications were still pending', async () => {
      const { client, project } = await ownedProject({ status: 'OPEN' });
      const pendingFreelancer = await makeFreelancer();
      const rejectedFreelancer = await makeFreelancer();
      await makeApplication(project.id, pendingFreelancer.id);
      const alreadyRejected = await makeApplication(project.id, rejectedFreelancer.id, {
        status: 'REJECTED',
      });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}/status`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBe(200);

      const notifications = await prisma.notification.findMany();
      expect(notifications.map((n) => n.userId)).toEqual([pendingFreelancer.id]);
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: alreadyRejected.id } })).status,
      ).toBe('REJECTED');
    });

    it('does not notify a soft-deleted applicant', async () => {
      const { client, project } = await ownedProject({ status: 'OPEN' });
      const deleted = await makeFreelancer({ deletedAt: new Date() });
      const application = await makeApplication(project.id, deleted.id);

      const res = await authed(client)
        .patch(`/api/projects/${project.id}/status`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBe(200);
      expect(await prisma.notification.count()).toBe(0);
      expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('REJECTED');
    });

    it('writes no notifications when the project has no applications', async () => {
      const { client, project } = await ownedProject({ status: 'UPCOMING' });

      const res = await authed(client)
        .patch(`/api/projects/${project.id}/status`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBe(200);
      expect(await prisma.notification.count()).toBe(0);
    });

    it('leaves applications and notifications alone for a non-CLOSED transition', async () => {
      const { client, project } = await ownedProject({ status: 'OPEN' });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(project.id, freelancer.id);

      const res = await authed(client)
        .patch(`/api/projects/${project.id}/status`)
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(200);
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status,
      ).toBe('PENDING');
      expect(await prisma.notification.count()).toBe(0);
    });

    // Fault injection through the `projectLifecycle` mock. Note the scope limit described in
    // the file header: this only makes the controller's *own* call to
    // `rejectPendingApplicationsForClosedProjects` throw. `closeExpiredOpenProjects` calls that
    // helper through a module-internal reference, so the sweep's transaction runs unmocked here
    // and its rollback is NOT asserted by this test — do not read this as covering it.
    it('rolls the whole transition back when one step fails (single transaction)', async () => {
      const { client, project } = await ownedProject({ status: 'OPEN' });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(project.id, freelancer.id);

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      lifecycleFault.failRejectPending = true;
      let res;
      try {
        res = await authed(client)
          .patch(`/api/projects/${project.id}/status`)
          .send({ status: 'CLOSED' });
      } finally {
        lifecycleFault.failRejectPending = false;
        consoleError.mockRestore();
      }

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { message: expect.any(String) } });

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.status).toBe('OPEN');
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status,
      ).toBe('PENDING');
      expect(await prisma.notification.count()).toBe(0);
    });
  });
});
