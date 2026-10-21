import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Two module boundaries are mocked so this file can exercise **every** mutating endpoint a
 * soft-deleted principal can reach without touching a real service:
 *
 * - `axios` — `POST /api/payments/confirm` calls TossPayments.
 * - `src/lib/openai` — `POST /api/projects/:id/analyze` calls OpenAI.
 *
 * Both are stubbed to *succeed*, which is what makes the D12 rows below meaningful: today the
 * write lands, so the "database is unchanged" assertion fails for a product reason rather than
 * because an upstream call blew up.
 */
vi.mock('axios', () => {
  const post = vi.fn();
  const get = vi.fn();
  return { default: { post, get } };
});

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('../src/lib/openai', () => ({
  default: { chat: { completions: { create: openaiCreate } } },
}));

import axios from 'axios';

import { api, authed, tokenFor } from './helpers/api';
import type { Principal } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeCareer,
  makeClient,
  makeContractScenario,
  makeFreelancer,
  makeMessage,
  makeMilestone,
  makePayment,
  makePayoutAccount,
  makePortfolioItem,
  makeProject,
  makeSubmission,
  makeUser,
  TEST_PASSWORD,
} from './helpers/factories';
import { generateRefreshToken } from '../src/lib/jwt';
import express from 'express';
import request from 'supertest';
import { requireActiveUser } from '../src/middlewares/activeUser';
import { authenticate } from '../src/middlewares/auth';
import { errorHandler } from '../src/middlewares/errorHandler';

// ---------------------------------------------------------------------------------------------
// Local helpers (kept in this file on purpose — the shared harness is off limits)
// ---------------------------------------------------------------------------------------------

/** `axios.post` is typed to return a full `AxiosResponse`; the mock returns a stub. */
const axiosPost = axios.post as unknown as Mock;

/** Just enough of a supertest response for these assertions. */
type Sent = { status: number; body: { error?: { message?: string } } };

/**
 * Request builder around an explicitly minted token. `authed(user)` mints one at call time,
 * which is fine — tokens are stateless, so deletion does not invalidate them — but every D12
 * case wants the token visibly issued *before* the deletion, which is the scenario the
 * divergence is about.
 */
function bearer(token: string) {
  return {
    get: (url: string) => api().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => api().post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => api().patch(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => api().put(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => api().delete(url).set('Authorization', `Bearer ${token}`),
  };
}

async function softDelete(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
}

async function restore(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { deletedAt: null } });
}

/** There is no notification factory in the shared harness, so build the row directly. */
function makeNotification(userId: string) {
  return prisma.notification.create({
    data: {
      userId,
      type: 'APPLICATION_CREATED',
      title: '새 지원자가 도착했습니다',
      message: '알림 본문',
      href: '/my/applications',
    },
  });
}

/** A value the tests can look for in the database — nothing legitimate ever writes it. */
const GHOST = 'ghost-write-by-deleted-user';

const VALID_ANALYSIS = JSON.stringify({
  features: [{ name: '기능 A', description: 'd', estimatedCost: 1_000_000, rationale: 'r', duration: '1주' }],
  totalAmount: 1_000_000,
  summary: 's',
  marketReference: 'm',
});

beforeEach(() => {
  axiosPost.mockReset();
  openaiCreate.mockReset();
  openaiCreate.mockResolvedValue({ choices: [{ message: { content: VALID_ANALYSIS } }] });
});

// ---------------------------------------------------------------------------------------------
// §5 / D12 — the write matrix
// ---------------------------------------------------------------------------------------------

/**
 * One row per mutating endpoint a soft-deleted principal can reach with a pre-deletion token.
 *
 * `setup` builds a fixture in which the request would *legitimately* succeed (right role,
 * ownership, complete profile, right resource state), so the only thing standing between the
 * caller and the write is the missing `deletedAt` re-check. `assertUnchanged` captures the
 * invariant that matters: **nothing the request would have written landed.** That assertion is
 * what flips when a guard is added; the status code is the secondary signal.
 *
 * `PATCH /api/contracts/:id` left this table in Phase 1: it answers 410 to everyone (CT11), so it
 * writes nothing and is no longer a D12 vector.
 *
 * Three mutating routes are deliberately absent, none of which can exhibit D12:
 * - `POST /api/auth/logout` — clears a cookie and writes no row.
 * - `POST /api/auth/select-role` — already filters `deletedAt: null`; asserted separately below.
 * - `POST /api/payments/dev-complete` — `ALLOW_PAYMENT_BYPASS` is `false` under test, so it
 *   answers 403 for *every* caller. A test here would pass for the wrong reason.
 */
type MutationCase = {
  actor: Principal;
  send: (token: string) => PromiseLike<Sent>;
  assertUnchanged: () => Promise<void>;
};

type Mutation = {
  /** Method and path, used verbatim in the test name. */
  label: string;
  setup: () => Promise<MutationCase>;
};

const mutations: Mutation[] = [
  {
    label: 'PATCH /api/users/me',
    async setup() {
      const actor = await makeFreelancer({ name: 'Before deletion', bio: null });
      return {
        actor,
        send: (token) => bearer(token).patch('/api/users/me').send({ name: GHOST, bio: GHOST }),
        async assertUnchanged() {
          const stored = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
          expect(stored.name).toBe('Before deletion');
          expect(stored.bio).toBeNull();
        },
      };
    },
  },
  {
    label: 'POST /api/projects',
    async setup() {
      const actor = await makeClient();
      return {
        actor,
        send: (token) => bearer(token).post('/api/projects').send({
          title: GHOST,
          description: GHOST,
          category: '웹 개발',
          budget: 1_000_000,
          deadline: daysFromNow(10).toISOString(),
        }),
        async assertUnchanged() {
          expect(await prisma.project.count({ where: { clientId: actor.id } })).toBe(0);
        },
      };
    },
  },
  {
    label: 'PATCH /api/projects/:id',
    async setup() {
      const actor = await makeClient();
      const project = await makeProject(actor.id, { title: 'Before deletion' });
      return {
        actor,
        send: (token) => bearer(token).patch(`/api/projects/${project.id}`).send({ title: GHOST }),
        async assertUnchanged() {
          const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
          expect(stored.title).toBe('Before deletion');
        },
      };
    },
  },
  {
    label: 'DELETE /api/projects/:id',
    async setup() {
      const actor = await makeClient();
      const project = await makeProject(actor.id);
      return {
        actor,
        send: (token) => bearer(token).delete(`/api/projects/${project.id}`),
        async assertUnchanged() {
          const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
          expect(stored.deletedAt).toBeNull();
        },
      };
    },
  },
  {
    label: 'PATCH /api/projects/:id/status',
    async setup() {
      const actor = await makeClient();
      const freelancer = await makeFreelancer();
      const project = await makeProject(actor.id, { status: 'OPEN' });
      const application = await makeApplication(project.id, freelancer.id);
      return {
        actor,
        send: (token) =>
          bearer(token).patch(`/api/projects/${project.id}/status`).send({ status: 'CLOSED' }),
        async assertUnchanged() {
          const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
          expect(stored.status).toBe('OPEN');
          const storedApplication = await prisma.application.findUniqueOrThrow({
            where: { id: application.id },
          });
          expect(storedApplication.status).toBe('PENDING');
          expect(await prisma.notification.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/projects/:id/applications',
    async setup() {
      const client = await makeClient();
      const actor = await makeFreelancer();
      const project = await makeProject(client.id, { status: 'OPEN' });
      return {
        actor,
        send: (token) => bearer(token).post(`/api/projects/${project.id}/applications`).send({
          coverLetter: GHOST,
          expectedRate: 1_000_000,
          expectedDuration: '2주',
        }),
        async assertUnchanged() {
          expect(await prisma.application.count({ where: { freelancerId: actor.id } })).toBe(0);
          expect(await prisma.notification.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'PATCH /api/projects/:projectId/applications/:appId',
    async setup() {
      const actor = await makeClient();
      const freelancer = await makeFreelancer();
      const project = await makeProject(actor.id, { status: 'OPEN' });
      const application = await makeApplication(project.id, freelancer.id);
      return {
        actor,
        send: (token) =>
          bearer(token)
            .patch(`/api/projects/${project.id}/applications/${application.id}`)
            .send({ status: 'ACCEPTED' }),
        async assertUnchanged() {
          const stored = await prisma.application.findUniqueOrThrow({
            where: { id: application.id },
          });
          expect(stored.status).toBe('PENDING');
          expect(await prisma.contract.count()).toBe(0);
          expect(await prisma.notification.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/projects/:id/bookmark',
    async setup() {
      const client = await makeClient();
      const actor = await makeFreelancer();
      const project = await makeProject(client.id);
      return {
        actor,
        send: (token) => bearer(token).post(`/api/projects/${project.id}/bookmark`),
        async assertUnchanged() {
          expect(await prisma.projectBookmark.count({ where: { userId: actor.id } })).toBe(0);
        },
      };
    },
  },
  {
    label: 'DELETE /api/projects/:id/bookmark',
    async setup() {
      const client = await makeClient();
      const actor = await makeFreelancer();
      const project = await makeProject(client.id);
      await prisma.projectBookmark.create({ data: { projectId: project.id, userId: actor.id } });
      return {
        actor,
        send: (token) => bearer(token).delete(`/api/projects/${project.id}/bookmark`),
        async assertUnchanged() {
          // The pre-existing bookmark must survive: deleting it is a write.
          expect(await prisma.projectBookmark.count({ where: { userId: actor.id } })).toBe(1);
        },
      };
    },
  },
  {
    label: 'POST /api/contracts/:id/sign',
    async setup() {
      const { freelancer, contract } = await makeContractScenario();
      return {
        actor: freelancer,
        send: (token) => bearer(token).post(`/api/contracts/${contract.id}/sign`),
        async assertUnchanged() {
          const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
          expect(stored.freelancerSigned).toBe(false);
          expect(stored.status).toBe('PENDING');
        },
      };
    },
  },
  {
    label: 'POST /api/payments',
    async setup() {
      const { client, milestone } = await makeContractScenario({
        contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      });
      return {
        actor: client,
        send: (token) => bearer(token).post('/api/payments').send({ milestoneId: milestone.id }),
        async assertUnchanged() {
          expect(await prisma.payment.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/payments/confirm',
    async setup() {
      const { client, milestone } = await makeContractScenario({
        contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      });
      const payment = await makePayment(milestone.id, client.id, { status: 'PENDING' });
      // The provider is stubbed to approve, so a 400 here can only come from a guard, never
      // from a failed verification.
      axiosPost.mockResolvedValue({ data: { status: 'DONE', totalAmount: payment.amount } });
      return {
        actor: client,
        send: (token) => bearer(token).post('/api/payments/confirm').send({
          paymentKey: 'toss_key_soft_deleted',
          orderId: payment.orderId,
          amount: payment.amount,
        }),
        async assertUnchanged() {
          const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
          // Neither COMPLETED (the happy path) nor FAILED (the catch path) — untouched.
          expect(stored.status).toBe('PENDING');
          expect(stored.paymentKey).toBeNull();
        },
      };
    },
  },
  {
    label: 'POST /api/reviews',
    async setup() {
      const { client, freelancer, contract } = await makeContractScenario({
        project: { status: 'COMPLETED' },
        contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
      });
      return {
        actor: client,
        send: (token) => bearer(token).post('/api/reviews').send({
          contractId: contract.id,
          revieweeId: freelancer.id,
          rating: 5,
          content: GHOST,
        }),
        async assertUnchanged() {
          expect(await prisma.review.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/projects/:id/analyze',
    async setup() {
      const actor = await makeClient();
      const project = await makeProject(actor.id);
      return {
        actor,
        send: (token) => bearer(token).post(`/api/projects/${project.id}/analyze`),
        async assertUnchanged() {
          expect(await prisma.pricingAnalysis.count({ where: { projectId: project.id } })).toBe(0);
        },
      };
    },
  },
  {
    label: 'PATCH /api/notifications/:id/read',
    async setup() {
      const actor = await makeFreelancer();
      const notification = await makeNotification(actor.id);
      return {
        actor,
        send: (token) => bearer(token).patch(`/api/notifications/${notification.id}/read`),
        async assertUnchanged() {
          const stored = await prisma.notification.findUniqueOrThrow({
            where: { id: notification.id },
          });
          expect(stored.readAt).toBeNull();
        },
      };
    },
  },
  {
    label: 'PATCH /api/notifications/read-all',
    async setup() {
      const actor = await makeFreelancer();
      await makeNotification(actor.id);
      await makeNotification(actor.id);
      return {
        actor,
        send: (token) => bearer(token).patch('/api/notifications/read-all'),
        async assertUnchanged() {
          expect(await prisma.notification.count({
            where: { userId: actor.id, readAt: null },
          })).toBe(2);
        },
      };
    },
  },
];

describe('a soft-deleted principal must not be able to write anything (D12)', () => {
  /**
   * Cross-cutting rule 5: "Every read and write must filter `deletedAt: null`." D1 fixed the
   * authentication and profile *read* paths; **no write path re-checks the actor**, which is
   * what D12 records.
   *
   * Current behavior, per endpoint: the request succeeds exactly as it would for a live user —
   * `PATCH /api/users/me` → 200 and the change persists, `POST /api/projects` → 201,
   * `POST /api/projects/:id/applications` → 201 with a real application row,
   * `POST /api/payments` → 201, `POST /api/contracts/:id/sign` → 200, and so on for every row
   * below. `authenticate` only verifies the JWT signature, `requireRole` reads the role out of
   * the token, and `requireCompleteProfile` looks the caller up with a plain `findUnique` that
   * ignores `deletedAt` — so nothing in the request path ever consults the flag.
   */
  it.fails.each(mutations)('$label is refused and writes nothing [D12]', async (mutation) => {
    const { actor, send, assertUnchanged } = await mutation.setup();
    const token = tokenFor(actor);

    await softDelete(actor.id);
    const res = await send(token);

    // The database assertion first: it is the invariant that matters, and the one that flips
    // the moment a guard lands.
    await assertUnchanged();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  /**
   * The counterpart that must keep passing once D12 is fixed: the block is the flag, not the
   * row, so a restored user can write again. Written against `PATCH /api/users/me` because it
   * is the cheapest write in the matrix.
   */
  it('lets a restored user write again — the block must be the flag, not the row', async () => {
    const actor = await makeFreelancer({ name: 'Before deletion' });
    const token = tokenFor(actor);

    await softDelete(actor.id);
    await restore(actor.id);

    const res = await bearer(token).patch('/api/users/me').send({ name: '복구됨' });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(stored.name).toBe('복구됨');
  });

  /**
   * The one write path that *is* guarded, which delimits D12's scope: `selectRole` looks the
   * caller up with `findFirst … deletedAt: null`, so it 404s. Every other mutating endpoint in
   * the matrix above lacks that lookup.
   */
  it('POST /api/auth/select-role is already guarded: 404, role unchanged', async () => {
    const actor = await makeUser({ role: 'FREELANCER', roleSelected: false });
    const token = tokenFor(actor);
    await softDelete(actor.id);

    const res = await bearer(token).post('/api/auth/select-role').send({ role: 'CLIENT' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(stored.role).toBe('FREELANCER');
    expect(stored.roleSelected).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// §5 / rule 12 — expansion routes mount `requireActiveUser`, so D12 must not reproduce on them
// ---------------------------------------------------------------------------------------------

/**
 * The counterpart of `mutations` for routes added by the platform expansion. Same row shape,
 * but run with a plain `it.each`: these routes put `requireActiveUser` behind `authenticate`,
 * so a soft-deleted caller is refused with 401 and nothing lands.
 *
 * Every expansion phase adds a row here for each new mutating route. **Never add an expansion
 * route to `mutations`** — that table is `it.fails`, and a guarded route would break it with an
 * unexpected pass. Phase 1 adds the milestone, plan and payout-account writes; Phase 3 adds the
 * notification-preferences write.
 */
const activeContract = () => makeContractScenario({
  contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
});

const guardedMutations: Mutation[] = [
  {
    label: 'PUT /api/contracts/:id/milestones',
    async setup() {
      const { client, contract, milestone } = await makeContractScenario();
      return {
        actor: client,
        send: (token) => bearer(token).put(`/api/contracts/${contract.id}/milestones`).send({
          milestones: [{ title: GHOST, amount: 4_000_000, dueDate: '2099-01-01' }],
        }),
        async assertUnchanged() {
          const stored = await prisma.milestone.findMany({ where: { contractId: contract.id } });
          expect(stored.map((m) => m.id)).toEqual([milestone.id]);
        },
      };
    },
  },
  {
    label: 'POST /api/milestones/:id/submissions',
    async setup() {
      const { freelancer, milestone } = await activeContract();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED' } });
      return {
        actor: freelancer,
        send: (token) => bearer(token).post(`/api/milestones/${milestone.id}/submissions`).send({ message: GHOST }),
        async assertUnchanged() {
          expect(await prisma.milestoneSubmission.count()).toBe(0);
          const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
          expect(stored.status).toBe('FUNDED');
        },
      };
    },
  },
  {
    label: 'POST /api/milestones/:id/approve',
    async setup() {
      const { client, milestone } = await activeContract();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });
      await makeSubmission(milestone.id);
      return {
        actor: client,
        send: (token) => bearer(token).post(`/api/milestones/${milestone.id}/approve`),
        async assertUnchanged() {
          const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
          expect(stored.status).toBe('SUBMITTED');
          expect(await prisma.settlementItem.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/milestones/:id/reject',
    async setup() {
      const { client, milestone } = await activeContract();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });
      await makeSubmission(milestone.id);
      return {
        actor: client,
        send: (token) => bearer(token).post(`/api/milestones/${milestone.id}/reject`).send({ reason: 'Please redo the whole thing.' }),
        async assertUnchanged() {
          const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
          expect(stored.status).toBe('SUBMITTED');
        },
      };
    },
  },
  {
    label: 'PUT /api/users/me/payout-account',
    async setup() {
      const actor = await makeFreelancer();
      return {
        actor,
        send: (token) => bearer(token).put('/api/users/me/payout-account').send({
          bankCode: '004',
          accountNumber: '1101234567',
          holderName: actor.name,
        }),
        async assertUnchanged() {
          expect(await prisma.payoutAccount.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'DELETE /api/users/me/payout-account',
    async setup() {
      const actor = await makeFreelancer();
      await makePayoutAccount(actor);
      return {
        actor,
        send: (token) => bearer(token).delete('/api/users/me/payout-account'),
        async assertUnchanged() {
          expect(await prisma.payoutAccount.count({ where: { userId: actor.id } })).toBe(1);
        },
      };
    },
  },
  // Phase 2B — portfolio and careers (PF20).
  {
    label: 'POST /api/users/me/portfolio',
    async setup() {
      const actor = await makeFreelancer();
      return {
        actor,
        send: (token) => bearer(token).post('/api/users/me/portfolio').send({ title: GHOST }),
        async assertUnchanged() {
          expect(await prisma.portfolioItem.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /api/conversations/:id/messages',
    async setup() {
      const { freelancer, conversation } = await makeContractScenario();
      return {
        actor: freelancer,
        send: (token) => bearer(token).post(`/api/conversations/${conversation.id}/messages`).send({ body: GHOST }),
        async assertUnchanged() {
          expect(await prisma.message.count()).toBe(0);
          expect(await prisma.job.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'PATCH /api/users/me/portfolio/:itemId',
    async setup() {
      const actor = await makeFreelancer();
      const item = await makePortfolioItem(actor.id, { title: 'Before deletion' });
      return {
        actor,
        send: (token) => bearer(token).patch(`/api/users/me/portfolio/${item.id}`).send({ title: GHOST }),
        async assertUnchanged() {
          expect((await prisma.portfolioItem.findUniqueOrThrow({ where: { id: item.id } })).title).toBe('Before deletion');
        },
      };
    },
  },
  {
    label: 'POST /api/conversations/:id/read',
    async setup() {
      const { client, freelancer, conversation } = await makeContractScenario();
      await makeMessage(conversation.id, client.id);
      return {
        actor: freelancer,
        send: (token) => bearer(token).post(`/api/conversations/${conversation.id}/read`),
        async assertUnchanged() {
          const me = await prisma.conversationParticipant.findFirstOrThrow({ where: { userId: freelancer.id } });
          expect(me.lastReadAt).toBeNull();
        },
      };
    },
  },
  {
    label: 'DELETE /api/users/me/portfolio/:itemId',
    async setup() {
      const actor = await makeFreelancer();
      const item = await makePortfolioItem(actor.id);
      return {
        actor,
        send: (token) => bearer(token).delete(`/api/users/me/portfolio/${item.id}`),
        async assertUnchanged() {
          expect(await prisma.portfolioItem.count({ where: { id: item.id } })).toBe(1);
        },
      };
    },
  },
  {
    label: 'PUT /api/users/me/portfolio/order',
    async setup() {
      const actor = await makeFreelancer();
      const first = await makePortfolioItem(actor.id);
      const second = await makePortfolioItem(actor.id);
      return {
        actor,
        send: (token) => bearer(token).put('/api/users/me/portfolio/order').send({ ids: [second.id, first.id] }),
        async assertUnchanged() {
          const stored = await prisma.portfolioItem.findMany({ where: { userId: actor.id }, orderBy: { sortOrder: 'asc' } });
          expect(stored.map((item) => item.id)).toEqual([first.id, second.id]);
        },
      };
    },
  },
  {
    label: 'POST /api/users/me/careers',
    async setup() {
      const actor = await makeFreelancer();
      return {
        actor,
        send: (token) => bearer(token).post('/api/users/me/careers').send({
          company: GHOST,
          position: 'Developer',
          employmentType: 'FULL_TIME',
          startDate: '2021-03',
        }),
        async assertUnchanged() {
          expect(await prisma.career.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'PATCH /api/users/me/careers/:careerId',
    async setup() {
      const actor = await makeFreelancer();
      const career = await makeCareer(actor.id, { company: 'Before deletion' });
      return {
        actor,
        send: (token) => bearer(token).patch(`/api/users/me/careers/${career.id}`).send({ company: GHOST }),
        async assertUnchanged() {
          expect((await prisma.career.findUniqueOrThrow({ where: { id: career.id } })).company).toBe('Before deletion');
        },
      };
    },
  },
  {
    label: 'DELETE /api/users/me/careers/:careerId',
    async setup() {
      const actor = await makeFreelancer();
      const career = await makeCareer(actor.id);
      return {
        actor,
        send: (token) => bearer(token).delete(`/api/users/me/careers/${career.id}`),
        async assertUnchanged() {
          expect(await prisma.career.count({ where: { id: career.id } })).toBe(1);
        },
      };
    },
  },
  {
    label: 'PUT /api/notifications/preferences',
    async setup() {
      const actor = await makeFreelancer();
      return {
        actor,
        send: (token) => bearer(token).put('/api/notifications/preferences').send({
          preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }],
        }),
        async assertUnchanged() {
          expect(await prisma.notificationPreference.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'DELETE /api/conversations/:id/messages/:messageId',
    async setup() {
      const { freelancer, conversation } = await makeContractScenario();
      const message = await makeMessage(conversation.id, freelancer.id);
      return {
        actor: freelancer,
        send: (token) => bearer(token).delete(`/api/conversations/${conversation.id}/messages/${message.id}`),
        async assertUnchanged() {
          expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deletedAt).toBeNull();
        },
      };
    },
  },
];

describe('expansion routes refuse a soft-deleted principal (requireActiveUser)', () => {
  it.each(guardedMutations)('$label → 401 and writes nothing', async (mutation) => {
    const { actor, send, assertUnchanged } = await mutation.setup();
    const token = tokenFor(actor);

    await softDelete(actor.id);
    const res = await send(token);

    await assertUnchanged();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Account is no longer active' } });
  });

  // The guard itself, on a probe route, so it is pinned before any expansion route uses it.
  const probe = express();
  probe.post('/probe', authenticate, requireActiveUser, (req, res) => res.json({ ok: true }));
  probe.use(errorHandler);

  it('requireActiveUser: 401 for a soft-deleted caller, pass-through once restored', async () => {
    const actor = await makeFreelancer();
    const token = tokenFor(actor);
    const send = () => request(probe).post('/probe').set('Authorization', `Bearer ${token}`);

    expect((await send()).status).toBe(200);

    await softDelete(actor.id);
    const refused = await send();
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: { message: 'Account is no longer active' } });

    await restore(actor.id);
    expect((await send()).status).toBe(200);
  });

  it('requireActiveUser: 401 for a token whose user no longer exists at all', async () => {
    const ghost: Principal = { id: 'missing-user-id', email: 'ghost@test.local', role: 'CLIENT' };

    const res = await request(probe).post('/probe').set('Authorization', `Bearer ${tokenFor(ghost)}`);

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// §5 / D1 (resolved) — the read and authentication paths, which must stay fixed
// ---------------------------------------------------------------------------------------------

describe('a soft-deleted user cannot authenticate or be looked up (D1, fixed)', () => {
  it('cannot log in, even with the correct password', async () => {
    const user = await makeUser();
    await softDelete(user.id);

    const res = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Invalid credentials' } });
  });

  it('cannot refresh with a pre-deletion refresh cookie', async () => {
    const user = await makeUser();
    // Minted directly rather than via login, so this test cannot fail because login is broken.
    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });
    await softDelete(user.id);

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${refreshToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('cannot refresh with a cookie obtained by logging in before the deletion', async () => {
    const user = await makeUser();
    const login = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const cookies = login.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = (cookies ?? []).find((c) => c.startsWith('refreshToken='));
    expect(cookie).toBeDefined();

    await softDelete(user.id);

    const res = await api().post('/api/auth/refresh').set('Cookie', cookie as string);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('404s at GET /api/users/me with a pre-deletion access token', async () => {
    const user = await makeFreelancer();
    const token = tokenFor(user);
    await softDelete(user.id);

    const res = await bearer(token).get('/api/users/me');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('404s at GET /api/users/:id — invisible to the public profile lookup', async () => {
    const user = await makeFreelancer();
    await softDelete(user.id);

    const res = await api().get(`/api/users/${user.id}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('can log in again once deletedAt is cleared', async () => {
    const user = await makeUser();
    const credentials = { email: user.email, password: TEST_PASSWORD };

    await softDelete(user.id);
    expect((await api().post('/api/auth/login').send(credentials)).status).toBe(401);

    await restore(user.id);

    const res = await api().post('/api/auth/login').send(credentials);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('is visible again at GET /api/users/:id once restored', async () => {
    const user = await makeFreelancer();
    await softDelete(user.id);
    expect((await api().get(`/api/users/${user.id}`)).status).toBe(404);

    await restore(user.id);

    const res = await api().get(`/api/users/${user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  /**
   * Deliberate exception, and the reason `signup` keeps a plain `findUnique`: `email` is unique
   * at the database level, so a soft-deleted row still occupies the address. Filtering
   * `deletedAt: null` there would report a taken address as free and then fail with P2002.
   */
  it('still 409s at POST /api/auth/signup for an email held by a soft-deleted user', async () => {
    const user = await makeUser({ email: 'taken-by-deleted@test.local' });
    await softDelete(user.id);

    const res = await api().post('/api/auth/signup').send({
      email: 'taken-by-deleted@test.local',
      password: TEST_PASSWORD,
      name: '새 사용자',
      role: 'CLIENT',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Email already in use' } });
    // No second row, and the deleted one is untouched.
    expect(await prisma.user.count({ where: { email: 'taken-by-deleted@test.local' } })).toBe(1);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.deletedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// §5 — a soft-deleted project is invisible to listing, fetching, applying and bookmarking
// ---------------------------------------------------------------------------------------------

type DeletedProjectFixture = {
  client: Principal;
  applicant: Principal;
  otherFreelancer: Principal;
  projectId: string;
  applicationId: string;
};

/**
 * A soft-deleted project that is otherwise entirely ordinary: OPEN before deletion, owned by a
 * live client, with one PENDING application from `applicant`. `otherFreelancer` has neither an
 * application nor a bookmark, so the "no row created" assertions cannot be satisfied by a
 * pre-existing row or short-circuited by the unique constraint.
 */
async function deletedProjectFixture(): Promise<DeletedProjectFixture> {
  const client = await makeClient();
  const applicant = await makeFreelancer();
  const otherFreelancer = await makeFreelancer();
  const project = await makeProject(client.id, { title: 'Soft deleted', status: 'OPEN' });
  const application = await makeApplication(project.id, applicant.id);
  await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

  return {
    client,
    applicant,
    otherFreelancer,
    projectId: project.id,
    applicationId: application.id,
  };
}

/**
 * Every route that resolves a project by id. `GET`/`DELETE /:id/bookmark` are deliberately
 * absent: they do not check the project at all, which is **D19**, covered in `bookmarks.test.ts`.
 */
const deletedProjectRoutes: { label: string; send: (fx: DeletedProjectFixture) => PromiseLike<Sent> }[] = [
  {
    label: 'GET /api/projects/:id',
    send: (fx) => api().get(`/api/projects/${fx.projectId}`),
  },
  {
    label: 'PATCH /api/projects/:id',
    send: (fx) => authed(fx.client).patch(`/api/projects/${fx.projectId}`).send({ title: GHOST }),
  },
  {
    label: 'DELETE /api/projects/:id',
    send: (fx) => authed(fx.client).delete(`/api/projects/${fx.projectId}`),
  },
  {
    label: 'PATCH /api/projects/:id/status',
    send: (fx) =>
      authed(fx.client).patch(`/api/projects/${fx.projectId}/status`).send({ status: 'CLOSED' }),
  },
  {
    label: 'POST /api/projects/:id/analyze',
    send: (fx) => authed(fx.client).post(`/api/projects/${fx.projectId}/analyze`),
  },
  {
    label: 'POST /api/projects/:id/applications',
    send: (fx) => authed(fx.otherFreelancer).post(`/api/projects/${fx.projectId}/applications`).send({
      coverLetter: GHOST,
      expectedRate: 1_000_000,
      expectedDuration: '2주',
    }),
  },
  {
    label: 'GET /api/projects/:id/applications',
    send: (fx) => authed(fx.client).get(`/api/projects/${fx.projectId}/applications`),
  },
  {
    label: 'PATCH /api/projects/:projectId/applications/:appId',
    send: (fx) =>
      authed(fx.client)
        .patch(`/api/projects/${fx.projectId}/applications/${fx.applicationId}`)
        .send({ status: 'ACCEPTED' }),
  },
  {
    label: 'POST /api/projects/:id/bookmark',
    send: (fx) => authed(fx.otherFreelancer).post(`/api/projects/${fx.projectId}/bookmark`),
  },
];

describe('a soft-deleted project', () => {
  it.each(deletedProjectRoutes)('$label 404s', async ({ send }) => {
    const fx = await deletedProjectFixture();

    const res = await send(fx);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
  });

  it('is absent from GET /api/projects under the default filter', async () => {
    const client = await makeClient();
    const visible = await makeProject(client.id, { title: 'Visible', status: 'OPEN' });
    const hidden = await makeProject(client.id, {
      title: 'Soft deleted',
      status: 'OPEN',
      deletedAt: new Date(),
    });

    const res = await api().get('/api/projects');

    expect(res.status).toBe(200);
    const ids = (res.body.projects as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);
    expect(res.body.meta.total).toBe(1);
  });

  /**
   * Every `status` value, each with a live twin: an empty page would otherwise pass this test
   * for the wrong reason (a filter that matches nothing looks identical to soft-delete working).
   * The schedules are chosen so the lifecycle sweep leaves each live project in its state.
   */
  it.each(['ALL', 'UPCOMING', 'OPEN', 'CLOSED'] as const)(
    'is absent from GET /api/projects?status=%s while its live twin is listed',
    async (status) => {
      const client = await makeClient();
      const states = ['UPCOMING', 'OPEN', 'CLOSED'] as const;
      const live: Record<string, string> = {};
      const deleted: string[] = [];

      for (const state of states) {
        const schedule = {
          recruitmentStartDate: state === 'UPCOMING' ? daysFromNow(5) : daysFromNow(-1),
          deadline: daysFromNow(30),
        };
        live[state] = (await makeProject(client.id, {
          title: `Live ${state}`,
          status: state,
          ...schedule,
        })).id;
        deleted.push((await makeProject(client.id, {
          title: `Deleted ${state}`,
          status: state,
          ...schedule,
          deletedAt: new Date(),
        })).id);
      }

      const res = await api().get(`/api/projects?status=${status}&limit=50`);

      expect(res.status).toBe(200);
      const ids = (res.body.projects as { id: string }[]).map((project) => project.id);
      const expected = status === 'ALL' ? states.map((state) => live[state]) : [live[status]];
      expect([...ids].sort()).toEqual([...expected].sort());
      expect(ids.filter((id) => deleted.includes(id))).toEqual([]);
      expect(res.body.meta.total).toBe(expected.length);
    },
  );

  it('cannot be applied to: no application row and no notification', async () => {
    const fx = await deletedProjectFixture();

    const res = await authed(fx.otherFreelancer)
      .post(`/api/projects/${fx.projectId}/applications`)
      .send({ coverLetter: GHOST, expectedRate: 1_000_000, expectedDuration: '2주' });

    expect(res.status).toBe(404);
    expect(await prisma.application.count({ where: { freelancerId: fx.otherFreelancer.id } })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('cannot be bookmarked via POST: no bookmark row', async () => {
    const fx = await deletedProjectFixture();

    const res = await authed(fx.otherFreelancer).post(`/api/projects/${fx.projectId}/bookmark`);

    expect(res.status).toBe(404);
    expect(await prisma.projectBookmark.count()).toBe(0);
  });

  it('is not re-deleted or edited through the owner routes', async () => {
    const fx = await deletedProjectFixture();
    const before = await prisma.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    await authed(fx.client).patch(`/api/projects/${fx.projectId}`).send({ title: GHOST });
    await authed(fx.client).delete(`/api/projects/${fx.projectId}`);
    await authed(fx.client).patch(`/api/projects/${fx.projectId}/status`).send({ status: 'CLOSED' });

    const after = await prisma.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(after.deletedAt?.getTime()).toBe(before.deletedAt?.getTime());
  });

  it('is not analyzed: OpenAI is never reached and no analysis row is written', async () => {
    const fx = await deletedProjectFixture();

    const res = await authed(fx.client).post(`/api/projects/${fx.projectId}/analyze`);

    expect(res.status).toBe(404);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(await prisma.pricingAnalysis.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// §5 / D21 — the contract endpoints never filter deletedAt
// ---------------------------------------------------------------------------------------------

/**
 * `getContract` and `signContract` resolve the contract with a plain `findUnique` and never
 * consult `deletedAt` on the joined project. Rule 5 ("every read and write must filter
 * `deletedAt: null`") decides the soft-deleted case, so a contract whose project is gone must be
 * invisible. Today both succeed: the contract is served with the deleted project embedded in
 * the body, and it can be signed. Completion moved to the milestone routes in Phase 1, which do
 * filter — that half of D21 is now a passing test. Interacts with D11/Q4 — once deleting a
 * project with a live contract is blocked, this state becomes much harder to reach.
 */
describe('a contract whose project is soft-deleted (D21)', () => {
  it.fails('is not served by GET /api/contracts/:id [D21]', async () => {
    const { client, project, contract } = await makeContractScenario();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
  });

  it.fails('cannot be signed: 404 and no signature recorded [D21]', async () => {
    const { freelancer, project, contract } = await makeContractScenario();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(404);
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(stored.freelancerSigned).toBe(false);
    expect(stored.status).toBe('PENDING');
  });

  it('cannot be completed: approving its last milestone is 404 and writes nothing [MS5] [D21]', async () => {
    const { client, project, contract, milestone } = await activeContract();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });
    await makeSubmission(milestone.id);
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Milestone not found' } });
    const storedContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const storedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const storedMilestone = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(storedContract.status).toBe('ACTIVE');
    expect(storedProject.status).not.toBe('COMPLETED');
    expect(storedMilestone.status).toBe('SUBMITTED');
  });
});

/** Rule 5 on the expansion routes: the deleted project hides its contract's milestones. */
describe('a contract whose project is soft-deleted, on the expansion routes (rule 5)', () => {
  async function deletedProjectContract() {
    const scenario = await activeContract();
    await prisma.milestone.update({ where: { id: scenario.milestone.id }, data: { status: 'SUBMITTED' } });
    await makeSubmission(scenario.milestone.id);
    await prisma.project.update({ where: { id: scenario.project.id }, data: { deletedAt: new Date() } });
    return scenario;
  }

  it('is left out of GET /api/contracts [CT1]', async () => {
    const { client } = await deletedProjectContract();

    const res = await authed(client).get('/api/contracts');

    expect(res.status).toBe(200);
    expect(res.body.contracts).toEqual([]);
  });

  it.each([
    ['GET /api/contracts/:id/milestones', (s: Awaited<ReturnType<typeof activeContract>>) => authed(s.client).get(`/api/contracts/${s.contract.id}/milestones`), 'Contract not found'],
    ['PUT /api/contracts/:id/milestones', (s: Awaited<ReturnType<typeof activeContract>>) => authed(s.client).put(`/api/contracts/${s.contract.id}/milestones`).send({ milestones: [{ title: 'x', amount: 4_000_000, dueDate: '2099-01-01' }] }), 'Contract not found'],
    ['GET /api/milestones/:id', (s: Awaited<ReturnType<typeof activeContract>>) => authed(s.freelancer).get(`/api/milestones/${s.milestone.id}`), 'Milestone not found'],
    ['POST /api/milestones/:id/reject', (s: Awaited<ReturnType<typeof activeContract>>) => authed(s.client).post(`/api/milestones/${s.milestone.id}/reject`).send({ reason: 'Not what we agreed on.' }), 'Milestone not found'],
    ['POST /api/payments', (s: Awaited<ReturnType<typeof activeContract>>) => authed(s.client).post('/api/payments').send({ milestoneId: s.milestone.id }), 'Milestone not found'],
  ] as const)('%s → 404 [MS5] [PY1]', async (_label, send, message) => {
    const scenario = await deletedProjectContract();

    const res = await send(scenario);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message } });
  });
});

// ---------------------------------------------------------------------------------------------
// §5 vs. the review lists — an unaddressed edge, filed under Q11
// ---------------------------------------------------------------------------------------------

/**
 * `getUserReviews` filters on `revieweeId` alone, with no `deletedAt` check on either party. So
 * a user who 404s at `GET /api/users/:id` still has their received reviews served — including
 * the reviewer's name and avatar for a soft-deleted reviewer.
 *
 * Filed as **Q11** rather than a new divergence number, because it is the same unanswered
 * question as the joined-owner case already pinned in `projects-list.test.ts`: rule 5 is
 * written about the record being read, and here the soft-deleted user is a *join target*, not
 * the record. The reviews themselves are not deleted. If Q11 is decided the strict way, these
 * three tests flip to expecting `[]` (or a 404) and move under a D-number.
 */
describe('review lists for a soft-deleted user (Q11)', () => {
  async function reviewedPair() {
    const { client, freelancer, contract } = await makeContractScenario({
      project: { status: 'COMPLETED' },
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });

    const clientReview = await prisma.review.create({
      data: {
        contractId: contract.id,
        reviewerId: client.id,
        revieweeId: freelancer.id,
        rating: 5,
        content: '훌륭한 작업물이었습니다',
        tags: ['성실함'],
      },
    });
    const freelancerReview = await prisma.review.create({
      data: {
        contractId: contract.id,
        reviewerId: freelancer.id,
        revieweeId: client.id,
        rating: 4,
        content: '소통이 원활했습니다',
        tags: [],
      },
    });

    return { client, freelancer, clientReview, freelancerReview };
  }

  it('GET /api/users/:id/reviews still returns reviews received by a soft-deleted user', async () => {
    const { freelancer, clientReview } = await reviewedPair();
    await softDelete(freelancer.id);

    // The profile itself is gone …
    expect((await api().get(`/api/users/${freelancer.id}`)).status).toBe(404);

    // … but the review list is not.
    const res = await api().get(`/api/users/${freelancer.id}/reviews`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: clientReview.id, rating: 5 });
  });

  it('GET /api/reviews/users/:id behaves identically — both mount points share the handler', async () => {
    const { freelancer } = await reviewedPair();
    await softDelete(freelancer.id);

    const viaUsers = await api().get(`/api/users/${freelancer.id}/reviews`);
    const viaReviews = await api().get(`/api/reviews/users/${freelancer.id}`);

    expect(viaReviews.status).toBe(viaUsers.status);
    expect(viaReviews.body).toEqual(viaUsers.body);
  });

  it('still embeds a soft-deleted reviewer in the reviewee\'s list', async () => {
    const { client, freelancer, freelancerReview } = await reviewedPair();
    await softDelete(freelancer.id);

    const res = await api().get(`/api/users/${client.id}/reviews`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: freelancerReview.id,
      reviewer: { id: freelancer.id, name: freelancer.name },
    });
  });
});
