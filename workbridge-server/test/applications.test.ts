import { afterEach, describe, expect, it, vi } from 'vitest';

import { app, authed } from './helpers/api';
import { prisma } from './helpers/db';
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
 *
 * Oracle: `docs/BEHAVIOR.md` § Applications. Tests assert intended behavior; where the
 * implementation diverges the test is marked `it.fails` with the divergence id.
 */

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** Every error body must be exactly `{ error: { message } }` (BEHAVIOR.md § cross-cutting 1). */
function expectErrorEnvelope(body: unknown) {
  expect(body).toEqual({ error: { message: expect.any(String) } });
}

const validApplyBody = {
  coverLetter: 'I have shipped three similar projects.',
  expectedRate: 3_300_000,
  expectedDuration: '6주',
};

/**
 * `expressInit` sets every response's prototype to `app.response`, so an own property here
 * shadows Express's method for this app only. The [D10] probe needs that to inject a fault after
 * the response has been sent; everything below exists so the injection cannot outlive the probe —
 * a leaked `json` patch would corrupt every test that runs after it.
 */
const responseProto = (app as unknown as { response: Record<string, unknown> }).response;
const PRISTINE_HAS_OWN_JSON = Object.prototype.hasOwnProperty.call(responseProto, 'json');
const PRISTINE_JSON = responseProto.json;

/**
 * Armed by the probe *before* it patches anything and disarmed in its own `finally`. The hook
 * runs even if the probe throws between the two, so no path can leave the patch installed.
 */
let restoreResponseJson: (() => void) | null = null;

afterEach(() => {
  const restore = restoreResponseJson;
  restoreResponseJson = null;
  restore?.();
});

describe('POST /api/projects/:id/applications', () => {
  /** Typed so `body` stays an object for `Object.keys` below rather than a union with `field`. */
  const missingFieldCases: [field: string, body: Record<string, unknown>][] = [
    ['coverLetter', { expectedRate: 3_300_000, expectedDuration: '6주' }],
    ['expectedRate', { coverLetter: 'hello', expectedDuration: '6주' }],
    ['expectedDuration', { coverLetter: 'hello', expectedRate: 3_300_000 }],
  ];

  describe.each(missingFieldCases)('missing %s', (field, body) => {
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
      expect(res.body.error.message).toBe('All fields are required');
      expect(await prisma.application.count()).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });
  });

  /**
   * `expectedRate: 0` never reaches the `parsedExpectedRate <= 0` check: `!expectedRate` is true
   * for `0`, so the required-field guard rejects it first. Both are 400 and the spec only
   * requires that a non-positive rate is refused, so this is not a divergence — but the message
   * is the one honest way to say *which* branch ran, and it is what makes the positivity cases
   * below distinguishable from this one.
   */
  it('400s on expectedRate 0 via the required-field guard, not the positivity check', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('All fields are required');
    expect(await prisma.application.count()).toBe(0);
  });

  it.each([
    ['non-numeric', 'abc'],
    ['negative', -5000],
    ['negative string', '-5000'],
    ['minus one', -1],
    // Truthy, unlike a bare `0`, so it gets past the required-field guard and is the one input
    // that actually exercises `parsedExpectedRate <= 0`.
    ['the numeric string "0"', '0'],
    ['whitespace', '   '],
  ])('400s on a %s expectedRate, from the positivity check', async (_label, expectedRate) => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body);
    expect(res.body.error.message).toBe('expectedRate must be a positive number');
    expect(await prisma.application.count()).toBe(0);
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

  // [D-unlisted] Cross-cutting rule 8: a malformed value must be 400, never 500. `coverLetter` and
  // `expectedDuration` are only truthiness-checked, so any truthy non-string reaches
  // `tx.application.create` and Prisma rejects it — 500. Same defect class as D16/D17 (a
  // non-string inside an array reaching Prisma), on fields the divergence table does not list.
  it.fails('400s on a non-string expectedDuration rather than 500 [D-unlisted, rule 8]', async () => {
    const res = await applyWithNonStringDuration();

    expect(res.status).toBe(400);
    expect(await prisma.application.count()).toBe(0);
  });

  // [D14] The same request also shows the leak: `errorHandler` renders `err.message` verbatim and
  // Prisma's formatted message embeds the absolute source path plus a source excerpt of the
  // controller. Asserted separately from the status above so each test fails for one reason —
  // this one stays failing even if rule 8 is fixed with a still-leaky message.
  it.fails('does not leak an absolute source path or source excerpt in the error body [D14]', async () => {
    const res = await applyWithNonStringDuration();

    const { message } = res.body.error;
    expect(message).not.toContain('src/controllers');
    expect(message).not.toContain('applications.controller');
    expect(message).not.toMatch(/→/);
  });

  it('404s for a project that does not exist', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${MISSING_ID}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Project not found');
  });

  // (Q11) Q11 asks whether the soft-delete rule reaches *joined* owners. On this path it does not:
  // the project of a soft-deleted client is still open for applications, and the
  // `APPLICATION_CREATED` notification is addressed to the deleted account. Pinned, not judged.
  it('still accepts an application for a project whose client is soft-deleted (Q11)', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(201);
    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(client.id);
  });

  // (Q8) Role gating reads the role from the **token**, not the row. A freelancer demoted to
  // CLIENT keeps FREELANCER access until the token expires: `requireRole` passes on the token's
  // role, and since `requireCompleteProfile` reads the row it only has to be complete for the
  // row's *new* role. The application is then created by a user who is now a CLIENT.
  it('lets a freelancer demoted to CLIENT keep applying until the token expires (Q8)', async () => {
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

  // (Q8) The other half of the split source of truth: the role gate reads the token, but
  // completeness reads the row — so the same demotion *without* client fields is stopped by
  // `requireCompleteProfile`, with the profile message rather than a role message.
  it('403s a demoted freelancer whose row is incomplete for its new role (Q8)', async () => {
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
    expectErrorEnvelope(res.body);

    // What closed the project and rejected the sibling application is the lazy sweep —
    // `closeExpiredOpenProjects()`, which `apply` awaits as its first statement, in the sweep's
    // own `$transaction` — *not* `apply`'s in-handler `deadline < now` branch. That branch reads
    // the project after the sweep has already flipped it to CLOSED, so `status === 'OPEN'` is
    // false and the branch is unreachable; the request falls through to the not-OPEN guard.
    // The [D-unlisted] test below asserts the message the unreachable branch would have produced,
    // and the sweep-before-validation test after it shows the writes happen even on a request
    // that 400s long before that branch.
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('CLOSED');
    const rejected = await prisma.application.findUniqueOrThrow({ where: { id: pending.id } });
    expect(rejected.status).toBe('REJECTED');

    // and the caller's own application was never created
    expect(await prisma.application.count({ where: { freelancerId: applicant.id } })).toBe(0);
  });

  // [D-unlisted] `apply` runs `closeExpiredOpenProjects()` before reading the project, so by the
  // time the `deadline < now` branch is evaluated the project is already CLOSED and its guard
  // (`project.status === 'OPEN' && project.deadline < new Date()`) cannot hold. That branch, its
  // in-handler transaction and its message are all dead code with zero coverage — nothing in this
  // file exercises them, and nothing can; the request falls through to the not-OPEN guard and
  // answers 'Project is not accepting applications'. Not in the divergence table; see report.
  it.fails('reports "Project deadline has passed" for an expired OPEN project [D-unlisted]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, {
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const applicant = await makeFreelancer();

    const res = await authed(applicant)
      .post(`/api/projects/${project.id}/applications`)
      .send(validApplyBody);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Project deadline has passed');
  });

  /**
   * Direct evidence for the claim above: the required-field guard sits *after* the sweep and
   * *before* the project is even read, so this request cannot have reached the `deadline < now`
   * branch — yet the project is closed and its pending application rejected anyway. The sweep is
   * the only possible author of those writes (cross-cutting rule 7: read paths write rows).
   */
  it('sweeps before validating the body, so an expired OPEN project closes even on a 400', async () => {
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
    expect(res.body.error.message).toBe('All fields are required');

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('CLOSED');
    const rejected = await prisma.application.findUniqueOrThrow({ where: { id: pending.id } });
    expect(rejected.status).toBe('REJECTED');
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

  it('accepts a numeric string expectedRate and stores it as a number', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ ...validApplyBody, expectedRate: '2500000.5' });

    expect(res.status).toBe(201);
    const persisted = await prisma.application.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(persisted.expectedRate).toBe(2_500_000.5);
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

  // [D10] `res.status(201).json(application)` sits inside `apply`'s inner `try`, so a throw from
  // the send path is re-thrown to the outer `catch`, reaches `errorHandler`, and `errorHandler`
  // attempts a second write on an already-sent response.
  //
  // There is no code after the send, so the only way to observe this is to make the send itself
  // fail. The patch below is applied to the Express response prototype **from the test** — no
  // file under `src/` is touched. The intended behavior is that a failure after the response has
  // gone out never causes a second write attempt, i.e. exactly one `res.json` call per request.
  //
  // Safety, because this is the only test in the suite that mutates shared framework state:
  // the restore closure is armed (`restoreResponseJson`) *before* the patch is installed, so the
  // file-level `afterEach` undoes it even if this test throws; the `finally` undoes it on the
  // normal path; and the plain test that follows fails loudly if either mechanism missed.
  it.fails('does not attempt a second response write when the send path throws [D10]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const hadOwn = Object.prototype.hasOwnProperty.call(responseProto, 'json');
    const originalJson = responseProto.json as (this: unknown, body: unknown) => unknown;
    // `errorHandler` logs every 500; the injected fault would otherwise print a stack trace.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const restore = () => {
      if (hadOwn) {
        responseProto.json = originalJson;
      } else {
        delete responseProto.json;
      }
      logged.mockRestore();
    };

    restoreResponseJson = restore;
    let jsonCalls = 0;

    try {
      responseProto.json = function patchedJson(this: unknown, body: unknown) {
        jsonCalls += 1;
        const sent = originalJson.call(this, body);
        if (jsonCalls === 1) {
          // Fault injected *after* the response has been written.
          throw new Error('simulated post-response failure');
        }
        return sent;
      };

      await authed(freelancer)
        .post(`/api/projects/${project.id}/applications`)
        .send(validApplyBody)
        .catch(() => undefined); // the second write destroys the socket; the status is irrelevant
    } finally {
      restore();
      restoreResponseJson = null;
    }

    // Assert the injection is gone *before* asserting anything about it, so the divergence
    // assertion below is the only thing this test can be failing on.
    expect(Object.prototype.hasOwnProperty.call(responseProto, 'json')).toBe(hadOwn);
    expect(responseProto.json).toBe(originalJson);

    // The divergence: `errorHandler` writes a second time, so `jsonCalls` is 2 today.
    expect(jsonCalls).toBe(1);
  });

  it('left the shared Express response prototype pristine after the [D10] probe', () => {
    expect(Object.prototype.hasOwnProperty.call(responseProto, 'json')).toBe(PRISTINE_HAS_OWN_JSON);
    expect(responseProto.json).toBe(PRISTINE_JSON);
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

  // (Q7) The endpoint is unpaginated and no decision has been made to change that: every
  // application comes back in one array and `limit`/`page` are ignored rather than honoured or
  // rejected. Pinned so the switch to pagination cannot happen silently.
  it('returns every application in one array, ignoring limit and page (Q7)', async () => {
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
    expect(res.body.error.message).toBe('Status must be ACCEPTED or REJECTED');
    const unchanged = await prisma.application.findUniqueOrThrow({ where: { id: s.chosen.id } });
    expect(unchanged.status).toBe('PENDING');
    expect(await prisma.contract.count()).toBe(0);
  });

  it('400s when status is missing entirely', async () => {
    const s = await scenario();

    const res = await authed(s.client).patch(url(s.project.id, s.chosen.id)).send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body);
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
      expect(contract.endDate.getTime()).toBe(s.project.deadline.getTime());

      // 4. the project closes
      const project = await prisma.project.findUniqueOrThrow({ where: { id: s.project.id } });
      expect(project.status).toBe('CLOSED');

      // 5. one acceptance notification and one rejection notification per loser
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
      expect(new Date(res.body.contract.endDate).getTime()).toBe(s.project.deadline.getTime());
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

    it('409s — not 500 — when accepting a sibling that the accept bulk-rejected [D4/D7]', async () => {
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
      expect(await prisma.notification.count()).toBe(0);
    });

    it('never leaves a project with two contracts after a burst of accepts', async () => {
      const s = await scenario();
      const ids = [s.chosen.id, s.otherA.id, s.otherB.id];

      const results = await Promise.all(
        ids.map((id) => authed(s.client).patch(url(s.project.id, id)).send({ status: 'ACCEPTED' })),
      );

      // Only the **database invariants** are asserted here, because they are the guarantee that
      // matters and the only part of this race that is deterministic.
      //
      // Deliberately not "exactly one 200": a winner that commits and then fails on the way out
      // (cf. [D10]) would leave the database correct without reporting 200.
      //
      // The losers' status codes are deliberately NOT asserted — see the `it.todo` below. Under a
      // warm connection pool these three transactions can deadlock, and Postgres `40P01` surfaces
      // as a 500 rather than rule 8's 409. Asserting 409 here made this test fail ~2 runs in 16.
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((code) => code === 200).length).toBeLessThanOrEqual(1);
      expect(await prisma.contract.count()).toBe(1);
      const accepted = await prisma.application.count({
        where: { projectId: s.project.id, status: 'ACCEPTED' },
      });
      expect(accepted).toBe(1);
    });

    // [D20] Of several simultaneous accepts on one project, every loser should be a 409 per
    // cross-cutting rule 8. Instead the three transactions can deadlock: Postgres raises `40P01`,
    // which Prisma surfaces as `PrismaClientUnknownRequestError` and `errorHandler` renders as a
    // 500. The D4 fix catches only `P2002`, so this class escapes it.
    //
    // Not written as `it.fails`: the deadlock only occurs when the requests genuinely interleave
    // (~2 in 16 full-suite runs, and never when the file runs alone), so an `it.fails` would report
    // "expected to fail but passed" most of the time — noisier than no test. Making a *deadlock*
    // deterministic needs two transactions taking locks in opposite orders, which this endpoint
    // does not expose. The invariant test above covers the part that must never break.
    it.todo('returns 409 rather than 500 to the losers of a concurrent accept burst [D20]');
  });
});
