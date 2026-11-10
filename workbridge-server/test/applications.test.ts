import { describe, expect, it, vi } from 'vitest';

import { authed } from './helpers/api';
import { DAY_MS, kstDateString, kstDateToEndOfDay } from '../src/lib/time';
import { prisma, sideClient } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeContract,
  makeFreelancer,
  makeProject,
} from './helpers/factories';

/**
 * Applications — the endpoints nested under `/api/projects`.
 */

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** Every error body must be exactly `{ error: { message } }`. */
function expectErrorEnvelope(body: unknown) {
  expect(body).toEqual({ error: { message: expect.any(String) } });
}

const validApplyBody = {
  coverLetter: 'I have shipped three similar projects.',
  expectedRate: 3_300_000,
  expectedDuration: '6주',
};

describe('POST /api/projects/:id/applications', () => {
  /** Typed so `body` stays an object for `Object.keys` below rather than a union with `field`. */
  const missingFieldCases: [field: string, body: Record<string, unknown>, message: string][] = [
    ['coverLetter', { expectedRate: 3_300_000, expectedDuration: '6주' }, 'Cover letter is required'],
    ['expectedRate', { coverLetter: 'hello', expectedDuration: '6주' }, 'Expected rate is required'],
    ['expectedDuration', { coverLetter: 'hello', expectedRate: 3_300_000 }, 'Expected duration is required'],
  ];

  describe.each(missingFieldCases)('missing %s', (field, body, message) => {
    it('400s and persists nothing', async () => {
      // The case really does omit the field it is named after — otherwise a future edit could
      // leave this asserting the 400 of some *other* missing field.
      expect(Object.keys(body)).not.toContain(field);
      expect(Object.keys(body)).toHaveLength(2);

      const client = await makeClient();
      const project = await makeProject(client.id);
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .post(`/api/projects/${project.id}/applications`)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(`${field}: ${message}`);
      expect(await prisma.application.count()).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });
  });

  /**
   * `expectedRate: 0` is present, so it is the positivity check that refuses it — the old
   * `!expectedRate` required-field guard used to answer `All fields are required` first.
   */
  it('400s on expectedRate 0 from the positivity check, not as a missing field', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('expectedRate: Expected rate must be a positive whole number of won');
    expect(await prisma.application.count()).toBe(0);
  });

  it.each([
    ['non-numeric', 'abc'],
    ['negative', -5000],
    ['negative string', '-5000'],
    ['minus one', -1],
    ['the numeric string "0"', '0'],
    ['whitespace', '   '],
    // Strict number parsing: `parseFloat` used to read these as 2500000 and 1.
    ['trailing-garbage', '2500000abc'],
    ['exponent', '1e6'],
    ['boolean', true],
    ['null', null],
    // Money-time rule: amounts are whole won.
    ['fractional', 2_500_000.5],
    ['fractional string', '1000.5'],
  ])('400s on a %s expectedRate, from the positivity check', async (_label, expectedRate) => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body);
    expect(res.body.error.message).toBe('expectedRate: Expected rate must be a positive whole number of won');
    expect(await prisma.application.count()).toBe(0);
  });

  it.each([
    ['0.4', 0.4],
    ['the string "0.99"', '0.99'],
  ])('400s on a positive expectedRate below 1 (%s), which is not a whole number of won', async (_label, expectedRate) => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'expectedRate: Expected rate must be a positive whole number of won' } });
    expect(await prisma.application.count()).toBe(0);
  });

  it('accepts an expectedRate of exactly 1', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate: 1 });

    expect(res.status).toBe(201);
  });

  /**
   * Posts a body whose `expectedDuration` is a number, silencing the 500 log `errorHandler`
   * emits, and restores the spy before the caller asserts anything.
   */
  async function applyWithNonStringDuration() {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return await authed(freelancer)
        .post(`/api/projects/${project.id}/applications`)
        .send({ ...validApplyBody, expectedDuration: 123 });
    } finally {
      logged.mockRestore();
    }
  }

  // A malformed value must be 400, never 500. `coverLetter` and `expectedDuration` used to be
  // only truthiness-checked, so a truthy non-string reached `tx.application.create` and Prisma
  // rejected it — a 500 whose body leaked the source path (#37). They are strings now.
  it('400s on a non-string expectedDuration rather than 500', async () => {
    const res = await applyWithNonStringDuration();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'expectedDuration: Expected duration must be a string' } });
    expect(await prisma.application.count()).toBe(0);
  });

  it('does not leak an absolute source path or source excerpt for a non-string expectedDuration', async () => {
    const res = await applyWithNonStringDuration();

    const { message } = res.body.error;
    expect(message).not.toContain('src/controllers');
    expect(message).not.toContain('applications.controller');
    expect(message).not.toMatch(/→/);
  });

  it.each([
    ['coverLetter', { coverLetter: 42 }, 'coverLetter: Cover letter must be a string'],
    ['coverLetter', { coverLetter: '   ' }, 'coverLetter: Cover letter is required'],
    ['expectedDuration', { expectedDuration: '' }, 'expectedDuration: Expected duration is required'],
  ])('400s on a malformed %s (%j)', async (_field, override, message) => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, ...override });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.application.count()).toBe(0);
  });

  it('404s for a project that does not exist', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${MISSING_ID}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Project not found');
  });

  // A project whose client is soft-deleted is hidden like a deleted project: no application,
  // and so no `APPLICATION_CREATED` for the deleted account.
  it('404s an application to a project whose client is soft-deleted and writes nothing', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  // Role gating reads the role from the **token**, not the row. A freelancer demoted to
  // CLIENT keeps FREELANCER access until the token expires: `requireRole` passes on the token's
  // role, and since `requireCompleteProfile` reads the row it only has to be complete for the
  // row's *new* role. The application is then created by a user who is now a CLIENT.
  it('lets a freelancer demoted to CLIENT keep applying until the token expires', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();
    const tokenFromBeforeDemotion = authed(freelancer);
    await prisma.user.update({
      where: { id: freelancer.id },
      data: { role: 'CLIENT', companyName: 'Now A Client', businessField: 'IT' },
    });

    const res = await tokenFromBeforeDemotion
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(201);
    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(persisted.freelancerId).toBe(freelancer.id);
    const applicant = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(applicant.role).toBe('CLIENT');
  });

  // The other half of the split source of truth: the role gate reads the token, but
  // completeness reads the row — so the same demotion *without* client fields is stopped by
  // `requireCompleteProfile`, with the profile message rather than a role message.
  it('403s a demoted freelancer whose row is incomplete for its new role', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();
    const tokenFromBeforeDemotion = authed(freelancer);
    await prisma.user.update({ where: { id: freelancer.id }, data: { role: 'CLIENT' } });

    const res = await tokenFromBeforeDemotion
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('프로필을 먼저 완성해주세요');
    expect(await prisma.application.count()).toBe(0);
  });

  it('closes an OPEN project whose deadline has passed and rejects the request with 400', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, {
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const earlier = await makeFreelancer();
    const pending = await makeApplication(project.id, earlier.id);
    const applicant = await makeFreelancer();

    const res = await authed(applicant)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Project is not accepting applications' } });

    // The lazy sweep (`closeExpiredOpenProjects()`, `apply`'s first step) closed the project and
    // rejected the sibling application before the status check saw it.
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('CLOSED');
    const rejected = await prisma.application.findUniqueOrThrow({ where: { id: pending.id } });
    expect(rejected.status).toBe('REJECTED');

    // and the caller's own application was never created
    expect(await prisma.application.count({ where: { freelancerId: applicant.id } })).toBe(0);
  });

  /**
   * Validation order: the body is validated before the controller runs, so an invalid body is a 400
   * with no side effects — the lazy sweep (the controller's first step) does not run either.
   */
  it('validates the body before sweeping, so a 400 writes nothing', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, {
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const earlier = await makeFreelancer();
    const pending = await makeApplication(project.id, earlier.id);
    const applicant = await makeFreelancer();

    const res = await authed(applicant)
      .post(`/api/projects/${project.id}/applications`)
      .send({ coverLetter: 'no rate, no duration' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('expectedRate: Expected rate is required');

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('OPEN');
    const untouched = await prisma.application.findUniqueOrThrow({ where: { id: pending.id } });
    expect(untouched.status).toBe('PENDING');
  });

  it('validates the body before the existence check: an invalid body for an unknown project is 400', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${MISSING_ID}/applications`)
      .send({ ...validApplyBody, expectedRate: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('expectedRate: Expected rate must be a positive whole number of won');
  });

  it.each([
    ['CLOSED', { status: 'CLOSED' as const }],
    ['CANCELLED', { status: 'CANCELLED' as const }],
    ['COMPLETED', { status: 'COMPLETED' as const }],
    ['IN_PROGRESS', { status: 'IN_PROGRESS' as const }],
    ['UPCOMING', { status: 'UPCOMING' as const, recruitmentStartDate: daysFromNow(5) }],
  ])('400s when the project is %s rather than OPEN', async (_label, overrides) => {
    const client = await makeClient();
    const project = await makeProject(client.id, overrides);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Project is not accepting applications');
    expect(await prisma.application.count()).toBe(0);
  });

  it('409s when the same freelancer applies twice, leaving one application', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const first = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);
    const second = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, coverLetter: 'second try', expectedRate: 1_000 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe('You have already applied to this project');

    const applications = await prisma.application.findMany({ where: { projectId: project.id } });
    expect(applications).toHaveLength(1);
    expect(applications[0].expectedRate).toBe(3_300_000);
    // the rolled-back second attempt must not have left its notification behind
    expect(await prisma.notification.count()).toBe(1);
  });

  it('creates a PENDING application and notifies the client in one transaction', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer({ name: '김프리' });

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      projectId: project.id,
      freelancerId: freelancer.id,
      coverLetter: validApplyBody.coverLetter,
      expectedRate: 3_300_000,
      expectedDuration: '6주',
      status: 'PENDING',
    });

    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(persisted.status).toBe('PENDING');
    expect(persisted.expectedRate).toBe(3_300_000);
    expect(persisted.freelancerId).toBe(freelancer.id);

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: client.id,
      type: 'APPLICATION_CREATED',
      href: `/projects/${project.id}/applications`,
      readAt: null,
    });
    expect(notifications[0].message).toContain('김프리');
    expect(notifications[0].message).toContain(project.title);
  });

  it('accepts an integer string expectedRate and stores it as a number', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate: '2500000' });

    expect(res.status).toBe(201);
    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(persisted.expectedRate).toBe(2_500_000);
  });

  it('lets two different freelancers apply to the same project', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const one = await makeFreelancer();
    const two = await makeFreelancer();

    const first = await authed(one).post(`/api/projects/${project.id}/applications`).send(validApplyBody);
    const second = await authed(two).post(`/api/projects/${project.id}/applications`).send(validApplyBody);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await prisma.application.count({ where: { projectId: project.id } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(2);
  });

  it('runs the lifecycle sweep first, so an UPCOMING project whose recruitment has started accepts the application', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, {
      status: 'UPCOMING',
      recruitmentStartDate: daysFromNow(-1),
      deadline: daysFromNow(20),
    });
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(201);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('OPEN');
  });
});

describe('GET /api/projects/:id/applications', () => {
  it('returns an empty list when nobody has applied', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns applications newest first', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const [a, b, c] = [await makeFreelancer(), await makeFreelancer(), await makeFreelancer()];
    const oldest = await makeApplication(project.id, a.id, { createdAt: daysFromNow(-3) });
    const middle = await makeApplication(project.id, b.id, { createdAt: daysFromNow(-2) });
    const newest = await makeApplication(project.id, c.id, { createdAt: daysFromNow(-1) });

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.status).toBe(200);
    expect(res.body.map((app: { id: string }) => app.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it('includes the freelancer public profile, the linked contract and the project budget', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { budget: 7_000_000, status: 'CLOSED' });
    const freelancer = await makeFreelancer({
      name: '이프리',
      bio: 'Backend specialist',
      portfolioUrl: 'https://example.test/portfolio',
    });
    const application = await makeApplication(project.id, freelancer.id, {
      status: 'ACCEPTED',
      expectedRate: 6_400_000,
    });
    const contract = await makeContract({
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    });

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [entry] = res.body;
    expect(entry).toMatchObject({
      id: application.id,
      status: 'ACCEPTED',
      expectedRate: 6_400_000,
      freelancer: {
        id: freelancer.id,
        name: '이프리',
        bio: 'Backend specialist',
        skills: ['React', 'Node.js'],
        activityCategory: '웹 개발',
        experienceYears: 3,
        hourlyRate: 50_000,
        portfolioUrl: 'https://example.test/portfolio',
      },
      contract: { id: contract.id, status: 'PENDING' },
      project: { budget: 7_000_000 },
    });
    // the public profile must not leak private fields
    expect(entry.freelancer.email).toBeUndefined();
    expect(entry.freelancer.password).toBeUndefined();
  });

  it('reports a null contract for an application that has none', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();
    await makeApplication(project.id, freelancer.id);

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.status).toBe(200);
    expect(res.body[0].contract).toBeNull();
  });

  it('rejects stale pending applications before returning, and persists that', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { status: 'CLOSED' });
    const freelancer = await makeFreelancer();
    const stale = await makeApplication(project.id, freelancer.id, { status: 'PENDING' });

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('REJECTED');
    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: stale.id } });
    expect(persisted.status).toBe('REJECTED');
  });

  it('leaves pending applications alone while the project is still open', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { status: 'OPEN' });
    const freelancer = await makeFreelancer();
    const pending = await makeApplication(project.id, freelancer.id);

    const res = await authed(client).get(`/api/projects/${project.id}/applications`);

    expect(res.body[0].status).toBe('PENDING');
    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: pending.id } });
    expect(persisted.status).toBe('PENDING');
  });

  // The endpoint is unpaginated and no decision has been made to change that: every
  // application comes back in one array and `limit`/`page` are ignored rather than honoured or
  // rejected. Pinned so the switch to pagination cannot happen silently.
  it('returns every application in one array, ignoring limit and page', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    for (let i = 0; i < 12; i += 1) {
      const freelancer = await makeFreelancer();
      await makeApplication(project.id, freelancer.id);
    }

    const res = await authed(client)
      .get(`/api/projects/${project.id}/applications?limit=2&page=1`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
  });

  it('only returns applications belonging to the requested project', async () => {
    const client = await makeClient();
    const mine = await makeProject(client.id);
    const other = await makeProject(client.id);
    const freelancer = await makeFreelancer();
    const wanted = await makeApplication(mine.id, freelancer.id);
    await makeApplication(other.id, freelancer.id);

    const res = await authed(client).get(`/api/projects/${mine.id}/applications`);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(wanted.id);
  });
});

describe('PATCH /api/projects/:projectId/applications/:appId', () => {
  /** client owns `project`; three freelancers have pending applications on it. */
  async function scenario() {
    const client = await makeClient();
    const project = await makeProject(client.id, {
      budget: 9_000_000,
      status: 'OPEN',
      deadline: daysFromNow(21),
    });
    const winner = await makeFreelancer();
    const loserA = await makeFreelancer();
    const loserB = await makeFreelancer();
    const chosen = await makeApplication(project.id, winner.id, { expectedRate: 3_300_000 });
    const otherA = await makeApplication(project.id, loserA.id, { expectedRate: 4_100_000 });
    const otherB = await makeApplication(project.id, loserB.id, { expectedRate: 5_200_000 });

    return { client, project, winner, loserA, loserB, chosen, otherA, otherB };
  }

  const url = (projectId: string, appId: string) =>
    `/api/projects/${projectId}/applications/${appId}`;

  type Answer = { status: number; body: unknown };

  /** Sends a supertest request now (it is lazy until awaited) and settles with its response. */
  function started(req: PromiseLike<Answer>) {
    return new Promise<Answer>((resolve, reject) => {
      req.then(resolve, reject);
    });
  }

  /**
   * Polls until `count` sessions of this database wait on a lock. Runs on the side client, never
   * the app's pool: the app's blocked transactions may hold every connection there (`sideClient`).
   */
  async function waitForLockWaiters(side: ReturnType<typeof sideClient>, count: number) {
    const giveUpAt = Date.now() + 5_000;
    for (;;) {
      const [{ waiting }] = await side.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting >= count) return;
      if (Date.now() > giveUpAt) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it.each([
    ['PENDING', 'PENDING'],
    ['a bogus value', 'BOGUS'],
    ['lowercase accepted', 'accepted'],
    ['an empty string', ''],
    ['a number', 1],
  ])('400s on %s as status', async (_label, status) => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(s.project.id, s.chosen.id)).send({ status });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('status: Status must be one of ACCEPTED, REJECTED');
    const unchanged = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
    expect(unchanged.status).toBe('PENDING');
    expect(await prisma.contract.count()).toBe(0);
  });

  it('400s when status is missing entirely', async () => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(s.project.id, s.chosen.id)).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'status: Status is required' } });
  });

  // Validation runs before the existence check.
  it('400s on an invalid status before checking that the project exists', async () => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(MISSING_ID, s.chosen.id)).send({ status: 'BOGUS' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('status: Status must be one of ACCEPTED, REJECTED');
  });

  it('404s for a project that does not exist', async () => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(MISSING_ID, s.chosen.id)).send({ status: 'ACCEPTED' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Project not found');
    expect(await prisma.contract.count()).toBe(0);
  });

  it('403s for a client who does not own the project', async () => {
    const s = await scenario();
    const intruder = await makeClient();

    const res = await authed(intruder).patch(url(s.project.id, s.chosen.id)).send({ status: 'ACCEPTED' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Not authorized');
    const unchanged = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
    expect(unchanged.status).toBe('PENDING');
    expect(await prisma.contract.count()).toBe(0);
  });

  it('404s for an application id that does not exist', async () => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(s.project.id, MISSING_ID)).send({ status: 'ACCEPTED' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Application not found');
  });

  it('404s for an application that belongs to a different project', async () => {
    const s = await scenario();
    const otherProject = await makeProject(s.client.id);
    const outsider = await makeFreelancer();
    const foreign = await makeApplication(otherProject.id, outsider.id);

    const res = await authed(s.client).patch(url(s.project.id, foreign.id)).send({ status: 'ACCEPTED' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Application not found');
    const untouched = await prisma.application.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(untouched.status).toBe('PENDING');
    expect(await prisma.contract.count()).toBe(0);
  });

  describe('ACCEPTED', () => {
    it('performs every effect of the accept transaction', async () => {
      const s = await scenario();
      const before = Date.now();

      const res = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);

      // 1. the chosen application is ACCEPTED
      const chosen = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
      expect(chosen.status).toBe('ACCEPTED');

      // 2. every other PENDING application is REJECTED
      const otherA = await prisma.application.findUniqueOrThrow({ where: { id: s.otherA.id } });
      const otherB = await prisma.application.findUniqueOrThrow({ where: { id: s.otherB.id } });
      expect([otherA.status, otherB.status]).toEqual(['REJECTED', 'REJECTED']);

      // 3. exactly one contract, priced from the application's expectedRate — not the budget
      const contracts = await prisma.contract.findMany();
      expect(contracts).toHaveLength(1);
      const [contract] = contracts;
      expect(contract.amount).toBe(3_300_000);
      expect(contract.amount).not.toBe(s.project.budget);
      expect(contract).toMatchObject({
        projectId: s.project.id,
        applicationId: s.chosen.id,
        clientId: s.client.id,
        freelancerId: s.winner.id,
        status: 'PENDING',
        clientSigned: false,
        freelancerSigned: false,
      });
      expect(contract.startDate.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(contract.startDate.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      // endDate is the default milestone's due date, not the recruitment deadline.
      const dueDate = kstDateToEndOfDay(kstDateString(new Date(before + 30 * DAY_MS)));
      expect(contract.endDate.getTime()).toBe(dueDate.getTime());

      // 4. the default milestone
      const milestones = await prisma.milestone.findMany({ where: { contractId: contract.id } });
      expect(milestones).toHaveLength(1);
      expect(milestones[0]).toMatchObject({
        sequence: 1,
        title: '전체 작업',
        description: null,
        amount: 3_300_000,
        status: 'PENDING',
      });
      expect(milestones[0].dueDate.getTime()).toBe(dueDate.getTime());

      // 5. the project closes
      const project = await prisma.project.findUniqueOrThrow({ where: { id: s.project.id } });
      expect(project.status).toBe('CLOSED');

      // 6. one acceptance notification and one rejection notification per loser
      const accepted = await prisma.notification.findMany({
        where: { type: 'APPLICATION_ACCEPTED' },
      });
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        userId: s.winner.id,
        href: `/contracts/${contract.id}`,
        readAt: null,
      });

      const rejections = await prisma.notification.findMany({
        where: { type: 'APPLICATION_REJECTED' },
        orderBy: { userId: 'asc' },
      });
      expect(rejections).toHaveLength(2);
      expect(rejections.map((n) => n.userId).sort()).toEqual([s.loserA.id, s.loserB.id].sort());
      rejections.forEach((n) => expect(n.href).toBe('/my/applications'));

      expect(await prisma.notification.count()).toBe(3);
    });

    it('7. opens the conversation: both parties, nothing read, and the CONTRACT_CREATED system message', async () => {
      const s = await scenario();

      const res = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { contractId: res.body.contract.id },
        include: { participants: true, messages: true },
      });
      expect(conversation.participants.map((p) => p.userId).sort()).toEqual([s.client.id, s.winner.id].sort());
      expect(conversation.participants.every((p) => p.lastReadAt === null)).toBe(true);
      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0]).toMatchObject({
        kind: 'SYSTEM',
        systemEvent: 'CONTRACT_CREATED',
        senderId: null,
        deletedAt: null,
      });
      // lastMessageAt is the system message's createdAt.
      expect(conversation.lastMessageAt?.getTime()).toBe(conversation.messages[0].createdAt.getTime());
      expect(await prisma.conversation.count()).toBe(1);
      // The system message creates no notification beyond step 6's three.
      expect(await prisma.notification.count()).toBe(3);
    });

    it('responds with { application, contract }', async () => {
      const s = await scenario();

      const res = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['application', 'contract']);
      expect(res.body.application).toMatchObject({ id: s.chosen.id, status: 'ACCEPTED' });
      expect(res.body.contract).toMatchObject({
        projectId: s.project.id,
        applicationId: s.chosen.id,
        amount: 3_300_000,
        status: 'PENDING',
      });
      const milestone = await prisma.milestone.findFirstOrThrow();
      expect(new Date(res.body.contract.endDate).getTime()).toBe(milestone.dueDate.getTime());
      expect(res.body.contract).not.toHaveProperty('milestones');
    });

    it('rounds a fractional contract amount to whole won for the default milestone', async () => {
      const client = await makeClient();
      const project = await makeProject(client.id);
      const freelancer = await makeFreelancer();
      const only = await makeApplication(project.id, freelancer.id, { expectedRate: 2_500_000.5 });

      const res = await authed(client).patch(url(project.id, only.id)).send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      expect(res.body.contract.amount).toBe(2_500_000.5);
      const milestone = await prisma.milestone.findFirstOrThrow();
      expect(milestone.amount).toBe(2_500_001);
    });

    it('creates no rejection notifications when there are no rival applications', async () => {
      const client = await makeClient();
      const project = await makeProject(client.id, { budget: 9_000_000 });
      const freelancer = await makeFreelancer();
      const only = await makeApplication(project.id, freelancer.id, { expectedRate: 1_234_567 });

      const res = await authed(client).patch(url(project.id, only.id)).send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      expect(await prisma.notification.count({ where: { type: 'APPLICATION_REJECTED' } })).toBe(0);
      expect(await prisma.notification.count()).toBe(1);
      const contract = await prisma.contract.findFirstOrThrow();
      expect(contract.amount).toBe(1_234_567);
    });

    it('leaves already-REJECTED rivals untouched and does not re-notify them', async () => {
      const s = await scenario();
      await prisma.application.update({
        where: { id: s.otherA.id },
        data: { status: 'REJECTED' },
      });

      const res = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      const rejections = await prisma.notification.findMany({
        where: { type: 'APPLICATION_REJECTED' },
      });
      expect(rejections).toHaveLength(1);
      expect(rejections[0].userId).toBe(s.loserB.id);
    });
  });

  describe('REJECTED', () => {
    it('rejects only that application and notifies only that freelancer', async () => {
      const s = await scenario();

      const res = await authed(s.client)
        .patch(url(s.project.id, s.otherA.id))
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: s.otherA.id, status: 'REJECTED' });

      const rejected = await prisma.application.findUniqueOrThrow({ where: { id: s.otherA.id } });
      expect(rejected.status).toBe('REJECTED');
      const stillPending = await prisma.application.findMany({
        where: { projectId: s.project.id, status: 'PENDING' },
        select: { id: true },
      });
      expect(stillPending.map((a) => a.id).sort()).toEqual([s.chosen.id, s.otherB.id].sort());

      const notifications = await prisma.notification.findMany();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        userId: s.loserA.id,
        type: 'APPLICATION_REJECTED',
        href: '/my/applications',
      });

      // rejecting creates no contract and does not close recruitment
      expect(await prisma.contract.count()).toBe(0);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: s.project.id } });
      expect(project.status).toBe('OPEN');
    });
  });

  describe('already-decided applications', () => {
    it('409s on a second accept of the same application, leaving one contract', async () => {
      const s = await scenario();

      const first = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });
      const second = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expectErrorEnvelope(second.body);
      expect(await prisma.contract.count()).toBe(1);
      expect(await prisma.notification.count()).toBe(3);
    });

    it('409s when rejecting an already-accepted application, preserving its status', async () => {
      const s = await scenario();

      await authed(s.client).patch(url(s.project.id, s.chosen.id)).send({ status: 'ACCEPTED' });
      const res = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(409);
      const chosen = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
      expect(chosen.status).toBe('ACCEPTED');
      expect(await prisma.contract.count()).toBe(1);
    });

    it('409s — not 500 — when accepting a sibling that the accept bulk-rejected', async () => {
      const s = await scenario();

      const accept = await authed(s.client)
        .patch(url(s.project.id, s.chosen.id))
        .send({ status: 'ACCEPTED' });
      expect(accept.status).toBe(200);

      const sibling = await authed(s.client)
        .patch(url(s.project.id, s.otherA.id))
        .send({ status: 'ACCEPTED' });

      expect(sibling.status).toBe(409);
      expect(sibling.status).not.toBe(500);
      expectErrorEnvelope(sibling.body);

      // the project must never end up with two contracts
      const contracts = await prisma.contract.findMany();
      expect(contracts).toHaveLength(1);
      expect(contracts[0].applicationId).toBe(s.chosen.id);
      const sibl = await prisma.application.findUniqueOrThrow({ where: { id: s.otherA.id } });
      expect(sibl.status).toBe('REJECTED');
    });

    it('409s when re-rejecting an already-rejected application, creating no second notification', async () => {
      const s = await scenario();

      const first = await authed(s.client)
        .patch(url(s.project.id, s.otherA.id))
        .send({ status: 'REJECTED' });
      const second = await authed(s.client)
        .patch(url(s.project.id, s.otherA.id))
        .send({ status: 'REJECTED' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(await prisma.notification.count()).toBe(1);
    });

    it('409s when accepting an application the lifecycle sweep already rejected', async () => {
      const client = await makeClient();
      const project = await makeProject(client.id, { status: 'CLOSED' });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(project.id, freelancer.id);
      // the sweep runs on the client's own listing read
      await authed(client).get(`/api/projects/${project.id}/applications`);

      const res = await authed(client).patch(url(project.id, application.id)).send({ status: 'ACCEPTED' });

      expect(res.status).toBe(409);
      expect(await prisma.contract.count()).toBe(0);
    });
  });

  describe('atomicity', () => {
    /**
     * A real, non-injected rollback probe: the project already has a contract (from an earlier
     * accept) while a rival application is still PENDING, so the accept transaction gets as far
     * as `contract.create` and then trips the unique `Contract.projectId`. Nothing from the
     * transaction may survive.
     */
    it('rolls the whole accept back when the contract insert violates the unique projectId', async () => {
      const client = await makeClient();
      const project = await makeProject(client.id, { status: 'OPEN', budget: 9_000_000 });
      const settled = await makeFreelancer();
      const rivalOne = await makeFreelancer();
      const rivalTwo = await makeFreelancer();
      const settledApp = await makeApplication(project.id, settled.id, { status: 'ACCEPTED' });
      const pendingOne = await makeApplication(project.id, rivalOne.id);
      const pendingTwo = await makeApplication(project.id, rivalTwo.id);
      await makeContract({
        projectId: project.id,
        applicationId: settledApp.id,
        clientId: client.id,
        freelancerId: settled.id,
      });

      const res = await authed(client)
        .patch(url(project.id, pendingOne.id))
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('A contract already exists for this project');

      // every step of the transaction rolled back
      const one = await prisma.application.findUniqueOrThrow({ where: { id: pendingOne.id } });
      const two = await prisma.application.findUniqueOrThrow({ where: { id: pendingTwo.id } });
      expect(one.status).toBe('PENDING');
      expect(two.status).toBe('PENDING');
      const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(after.status).toBe('OPEN');
      expect(await prisma.contract.count()).toBe(1);
      expect(await prisma.milestone.count()).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });

    it('rolls the whole accept back when creating the default milestone fails', async () => {
      const s = await scenario();
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "Milestone" ADD CONSTRAINT "tmp_no_default" CHECK ("title" <> '전체 작업')`,
      );
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await authed(s.client)
          .patch(url(s.project.id, s.chosen.id))
          .send({ status: 'ACCEPTED' });

        expect(res.status).toBe(500);
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.milestone.count()).toBe(0);
        const chosen = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
        expect(chosen.status).toBe('PENDING');
        const project = await prisma.project.findUniqueOrThrow({ where: { id: s.project.id } });
        expect(project.status).not.toBe('CLOSED');
        expect(await prisma.notification.count()).toBe(0);
      } finally {
        logs.mockRestore();
        await prisma.$executeRawUnsafe(`ALTER TABLE "Milestone" DROP CONSTRAINT "tmp_no_default"`);
      }
    });

    it('rolls the whole accept back when opening the conversation fails', async () => {
      const s = await scenario();
      await prisma.$executeRawUnsafe(`ALTER TABLE "Message" ADD CONSTRAINT "tmp_no_messages" CHECK (false) NOT VALID`);
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await authed(s.client)
          .patch(url(s.project.id, s.chosen.id))
          .send({ status: 'ACCEPTED' });

        expect(res.status).toBe(500);
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.milestone.count()).toBe(0);
        expect(await prisma.conversation.count()).toBe(0);
        expect(await prisma.conversationParticipant.count()).toBe(0);
        expect(await prisma.notification.count()).toBe(0);
        const chosen = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
        expect(chosen.status).toBe('PENDING');
      } finally {
        logs.mockRestore();
        await prisma.$executeRawUnsafe(`ALTER TABLE "Message" DROP CONSTRAINT "tmp_no_messages"`);
      }
    });

    /**
     * The interleaving that used to deadlock, made deterministic. A test transaction holds the
     * chosen application's row; the first accept queues behind it, then the second accept takes
     * its own application and queues behind the same row. Released, the first accept would need
     * the second's application to reject it while the second needs the first's — a cycle. With
     * the project row locked first, the second accept simply waits its turn and conflicts.
     */
    it('answers the losing accept 409, not a deadlock 500, when two accepts interleave', async () => {
      const s = await scenario();

      // The holder and the poll run on their own pool — see `sideClient`.
      const side = sideClient();
      let first: Promise<Answer> | undefined;
      let second: Promise<Answer> | undefined;
      try {
        await side.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${s.chosen.id} FOR UPDATE`;

          first = started(authed(s.client).patch(url(s.project.id, s.chosen.id)).send({ status: 'ACCEPTED' }));
          await waitForLockWaiters(side, 1);
          second = started(authed(s.client).patch(url(s.project.id, s.otherA.id)).send({ status: 'ACCEPTED' }));
          await waitForLockWaiters(side, 2);
        }, { timeout: 10_000 });
      } finally {
        await side.$disconnect();
      }

      const [a, b] = await Promise.all([first!, second!]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body).toEqual({ error: { message: 'A contract already exists for this project' } });
      expect(await prisma.contract.count()).toBe(1);
      expect(
        await prisma.application.count({ where: { projectId: s.project.id, status: 'ACCEPTED' } }),
      ).toBe(1);
    }, 20_000);

    it('404s an accept that was waiting on the project while the project was deleted', async () => {
      const s = await scenario();

      const side = sideClient();
      let pending: Promise<Answer> | undefined;
      try {
        await side.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${s.project.id} FOR UPDATE`;

          pending = started(authed(s.client).patch(url(s.project.id, s.chosen.id)).send({ status: 'ACCEPTED' }));
          await waitForLockWaiters(side, 1);
          await tx.project.update({ where: { id: s.project.id }, data: { deletedAt: new Date() } });
        }, { timeout: 10_000 });
      } finally {
        await side.$disconnect();
      }

      const res = await pending!;
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Project not found' } });
      expect(await prisma.contract.count()).toBe(0);
      const chosen = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
      expect(chosen.status).toBe('PENDING');
    }, 20_000);

    it('never leaves a project with two contracts after a burst of accepts', async () => {
      const s = await scenario();
      const ids = [s.chosen.id, s.otherA.id, s.otherB.id];

      const results = await Promise.all(
        ids.map((id) => authed(s.client).patch(url(s.project.id, id)).send({ status: 'ACCEPTED' })),
      );

      // One accept wins; the others conflict. Accepts of one project are serialized on its row,
      // so no ordering of the three transactions can deadlock into a 500.
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409]);
      expect(await prisma.contract.count()).toBe(1);
      const accepted = await prisma.application.count({
        where: { projectId: s.project.id, status: 'ACCEPTED' },
      });
      expect(accepted).toBe(1);
    });
  });
});
