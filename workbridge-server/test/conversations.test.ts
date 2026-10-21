import { describe, expect, it } from 'vitest';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import { jobsOf, runJobs } from './helpers/jobs';
import {
  makeApplication,
  makeClient,
  makeContractScenario,
  makeFreelancer,
  makeMessage,
  makePayment,
  makeProject,
} from './helpers/factories';
import { DAY_MS, HOUR_MS } from '../src/lib/time';

/**
 * Conversations — BEHAVIOR.md MG2–MG13, MG18, MG19, and the system messages of the events not
 * covered next to their own routes (plan replacement, automatic approval, the full lifecycle).
 * Messages and cursors are in messages.test.ts; unread state and the digest in
 * message-read.test.ts. The 401/403 matrix is in authorization.test.ts.
 */

type Scenario = Awaited<ReturnType<typeof makeContractScenario>>;

/** A conversation as `GET /:id` returns it. */
const getConversation = (user: Scenario['client'], id: string) => authed(user).get(`/api/conversations/${id}`);

/** Soft-deletes `userId` (rule 5). */
const softDelete = (userId: string) => prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });

/** The conversation's system events, oldest first. */
async function systemEvents(conversationId: string) {
  const messages = await prisma.message.findMany({
    where: { conversationId, kind: 'SYSTEM' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return messages.map((m) => m.systemEvent);
}

// ---------------------------------------------------------------------------------------------
// GET /api/conversations/:id
// ---------------------------------------------------------------------------------------------

describe('GET /api/conversations/:id', () => {
  it('returns the conversation object for either participant, without any email [MG13] [MG5]', async () => {
    const { client, freelancer, project, contract, conversation } = await makeContractScenario();
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: freelancer.id },
      data: { lastReadAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    const asClient = await getConversation(client, conversation.id);
    const asFreelancer = await getConversation(freelancer, conversation.id);

    expect(asClient.status).toBe(200);
    expect(Object.keys(asClient.body)).toEqual(['conversation']);
    expect(Object.keys(asClient.body.conversation).sort()).toEqual([
      'canSend', 'closedReason', 'closesAt', 'contract', 'contractId', 'counterpart', 'counterpartLastReadAt',
      'createdAt', 'id', 'lastMessageAt', 'myLastReadAt', 'myRole', 'project', 'unreadCount',
    ]);
    expect(asClient.body.conversation).toMatchObject({
      id: conversation.id,
      contractId: contract.id,
      myRole: 'CLIENT',
      contract: { id: contract.id, status: 'PENDING', completedAt: null },
      project: { id: project.id, title: project.title },
      counterpart: { id: freelancer.id, name: freelancer.name, profileImage: null },
      lastMessageAt: null,
      unreadCount: 0,
      myLastReadAt: null,
      counterpartLastReadAt: '2026-01-01T00:00:00.000Z',
      canSend: true,
      closedReason: null,
      closesAt: null,
    });
    expect(Object.keys(asClient.body.conversation.counterpart).sort()).toEqual(['id', 'name', 'profileImage']);
    expect(Object.keys(asClient.body.conversation.project).sort()).toEqual(['id', 'title']);
    expect(JSON.stringify(asClient.body)).not.toContain('@');

    expect(asFreelancer.body.conversation).toMatchObject({
      myRole: 'FREELANCER',
      counterpart: { id: client.id },
      myLastReadAt: '2026-01-01T00:00:00.000Z',
      counterpartLastReadAt: null,
    });
  });

  it('counts unread text from the other participant only [MG5] [MG8]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id);
    await makeMessage(conversation.id, freelancer.id);
    await makeMessage(conversation.id, client.id);
    await makeMessage(conversation.id, null);

    const asClient = await getConversation(client, conversation.id);
    const asFreelancer = await getConversation(freelancer, conversation.id);

    expect(asClient.body.conversation.unreadCount).toBe(2);
    expect(asFreelancer.body.conversation.unreadCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Who may post (MG9)
// ---------------------------------------------------------------------------------------------

describe('canSend, closedReason and closesAt', () => {
  it.each(['PENDING', 'ACTIVE'] as const)('a %s contract is open with no closesAt [MG9]', async (status) => {
    const { client, conversation } = await makeContractScenario({ contract: { status } });

    const res = await getConversation(client, conversation.id);

    expect(res.body.conversation).toMatchObject({ canSend: true, closedReason: null, closesAt: null });
  });

  it('a COMPLETED contract stays open until completedAt + 30 × 24 h, exclusive [MG9] [MG1]', async () => {
    const justInside = new Date(Date.now() - 30 * DAY_MS + HOUR_MS);
    const { client, conversation } = await makeContractScenario({
      contract: { status: 'COMPLETED', completedAt: justInside },
    });

    const res = await getConversation(client, conversation.id);

    expect(res.body.conversation).toMatchObject({
      canSend: true,
      closedReason: null,
      closesAt: new Date(justInside.getTime() + 30 * DAY_MS).toISOString(),
      contract: { status: 'COMPLETED', completedAt: justInside.toISOString() },
    });
  });

  it('closes once now reaches closesAt [MG9]', async () => {
    const completedAt = new Date(Date.now() - 30 * DAY_MS - 1000);
    const { client, conversation } = await makeContractScenario({ contract: { status: 'COMPLETED', completedAt } });

    const res = await getConversation(client, conversation.id);

    expect(res.body.conversation).toMatchObject({
      canSend: false,
      closedReason: 'CONTRACT_CLOSED',
      closesAt: new Date(completedAt.getTime() + 30 * DAY_MS).toISOString(),
    });
  });

  it('a soft-deleted counterpart closes posting, and stays visible as stored [MG9] [MG10] (Q11)', async () => {
    const { client, freelancer, conversation } = await makeContractScenario({ contract: { status: 'ACTIVE' } });
    await softDelete(freelancer.id);

    const res = await getConversation(client, conversation.id);

    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({
      canSend: false,
      closedReason: 'COUNTERPART_INACTIVE',
      closesAt: null,
      counterpart: { id: freelancer.id, name: freelancer.name },
    });
  });

  it('the first matching row decides: closed beats an inactive counterpart [MG9]', async () => {
    const completedAt = new Date(Date.now() - 31 * DAY_MS);
    const { client, freelancer, conversation } = await makeContractScenario({ contract: { status: 'COMPLETED', completedAt } });
    await softDelete(freelancer.id);

    const res = await getConversation(client, conversation.id);

    expect(res.body.conversation).toMatchObject({ canSend: false, closedReason: 'CONTRACT_CLOSED' });
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------------------------

describe('GET /api/conversations', () => {
  /** Three conversations of one freelancer: two with messages, one without. */
  async function three() {
    const freelancer = await makeFreelancer();
    const make = async (createdAt: string) => {
      const client = await makeClient();
      const project = await makeProject(client.id, { status: 'CLOSED' });
      const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
      const contract = await prisma.contract.create({
        data: {
          projectId: project.id,
          applicationId: application.id,
          clientId: client.id,
          freelancerId: freelancer.id,
          amount: 4_000_000,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * DAY_MS),
        },
      });
      const conversation = await prisma.conversation.create({
        data: {
          contractId: contract.id,
          createdAt: new Date(createdAt),
          participants: { create: [{ userId: client.id }, { userId: freelancer.id }] },
        },
      });
      return { client, project, contract, conversation };
    };
    const silentOld = await make('2026-01-01T00:00:00.000Z');
    const busy = await make('2026-01-02T00:00:00.000Z');
    const silentNew = await make('2026-01-03T00:00:00.000Z');
    const recent = await make('2026-01-04T00:00:00.000Z');
    await makeMessage(busy.conversation.id, busy.client.id, { createdAt: new Date('2026-03-01T00:00:00.000Z') });
    await makeMessage(recent.conversation.id, freelancer.id, { createdAt: new Date('2026-02-01T00:00:00.000Z') });
    return { freelancer, silentOld, busy, silentNew, recent };
  }

  it('orders by lastMessageAt desc, conversations without messages last by createdAt desc [MG11]', async () => {
    const { freelancer, silentOld, busy, silentNew, recent } = await three();

    const res = await authed(freelancer).get('/api/conversations');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 20, totalPages: 1 });
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([
      busy.conversation.id,
      recent.conversation.id,
      silentNew.conversation.id,
      silentOld.conversation.id,
    ]);
  });

  it('each entry is a conversation object plus lastMessage, the newest message or null [MG11] [MG4]', async () => {
    const { freelancer, busy, silentOld } = await three();

    const res = await authed(freelancer).get('/api/conversations');
    const first = res.body.conversations[0];
    const last = res.body.conversations[3];

    expect(first).toMatchObject({
      id: busy.conversation.id,
      myRole: 'FREELANCER',
      counterpart: { id: busy.client.id },
      project: { id: busy.project.id, title: busy.project.title },
      unreadCount: 1,
      canSend: true,
      lastMessageAt: '2026-03-01T00:00:00.000Z',
      lastMessage: {
        conversationId: busy.conversation.id,
        kind: 'TEXT',
        systemEvent: null,
        sender: { id: busy.client.id, name: busy.client.name, profileImage: null },
        deleted: false,
        attachments: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        readByCounterpart: null,
      },
    });
    expect(last).toMatchObject({ id: silentOld.conversation.id, lastMessage: null, lastMessageAt: null });
    expect(JSON.stringify(res.body)).not.toContain('@');
  });

  it("shows a deleted newest message as a tombstone in lastMessage [MG11] [MG4]", async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const message = await makeMessage(conversation.id, freelancer.id, {
      body: '지울 메시지',
      deletedAt: new Date(),
      attachments: [{ fileName: '비밀.pdf' }],
    });

    const res = await authed(client).get('/api/conversations');

    expect(res.body.conversations[0].lastMessage).toMatchObject({
      id: message.id,
      body: '',
      deleted: true,
      attachments: [],
    });
    expect(res.body.conversations[0].unreadCount).toBe(0);
  });

  it('paginates with page and limit exactly as CT2, capping limit at 50 [MG11] [MG1]', async () => {
    const { freelancer, busy, recent, silentNew } = await three();

    const page1 = await authed(freelancer).get('/api/conversations?limit=2');
    const page2 = await authed(freelancer).get('/api/conversations?limit=2&page=2');
    const capped = await authed(freelancer).get('/api/conversations?limit=500');
    const empty = await authed(freelancer).get('/api/conversations?limit=&page=');

    expect(page1.body.meta).toEqual({ total: 4, page: 1, limit: 2, totalPages: 2 });
    expect(page1.body.conversations.map((c: { id: string }) => c.id)).toEqual([busy.conversation.id, recent.conversation.id]);
    expect(page2.body.conversations[0].id).toBe(silentNew.conversation.id);
    expect(capped.body.meta.limit).toBe(50);
    expect(empty.body.meta).toMatchObject({ page: 1, limit: 20 });
  });

  it.each([
    ['limit=0', 'limit: must be at least 1'],
    ['page=0', 'page: must be at least 1'],
    ['limit=1.5', 'limit: must be an integer'],
    ['page=2abc', 'page: must be an integer'],
    ['limit=1&limit=2', 'limit: must be a single value'],
    ['page=1000001', 'page: must be at most 1000000'],
  ])('400s for %s [MG11] (CT2)', async (query, message) => {
    const user = await makeFreelancer();

    const res = await authed(user).get(`/api/conversations?${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
  });

  it('leaves out conversations whose project is soft-deleted [MG10] [MG11]', async () => {
    const kept = await makeContractScenario();
    // The conversation's participants follow the contract's parties (makeConversation).
    const gone = await makeContractScenario({ contract: { freelancerId: kept.freelancer.id } });
    await prisma.project.update({ where: { id: gone.project.id }, data: { deletedAt: new Date() } });

    const res = await authed(kept.freelancer).get('/api/conversations');

    expect(res.body.meta.total).toBe(1);
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([kept.conversation.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/conversations/unread-count
// ---------------------------------------------------------------------------------------------

describe('GET /api/conversations/unread-count', () => {
  it('sums MG8 over the caller\'s conversations [MG12]', async () => {
    const a = await makeContractScenario();
    const b = await makeContractScenario({ contract: { freelancerId: a.freelancer.id } });
    await makeMessage(a.conversation.id, a.client.id);
    await makeMessage(a.conversation.id, a.client.id);
    await makeMessage(b.conversation.id, b.client.id);
    await makeMessage(b.conversation.id, a.freelancer.id); // own
    await makeMessage(b.conversation.id, null); // system

    const res = await authed(a.freelancer).get('/api/conversations/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 3 });
    expect((await authed(a.client).get('/api/conversations/unread-count')).body).toEqual({ unreadCount: 0 });
  });

  it('is 0 for a user with no conversation — the path is never read as an id [MG12]', async () => {
    const user = await makeClient();

    const res = await authed(user).get('/api/conversations/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0 });
  });

  it('excludes conversations whose project is soft-deleted [MG10] [MG12]', async () => {
    const { client, freelancer, project, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id);
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).get('/api/conversations/unread-count');

    expect(res.body).toEqual({ unreadCount: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Soft-deleted project (MG10)
// ---------------------------------------------------------------------------------------------

describe('a conversation whose project is soft-deleted', () => {
  it.each([
    ['GET /api/conversations/:id', 'get', ''],
    ['GET /api/conversations/:id/messages', 'get', '/messages'],
    ['POST /api/conversations/:id/messages', 'post', '/messages'],
    ['POST /api/conversations/:id/read', 'post', '/read'],
    ['DELETE /api/conversations/:id/messages/:messageId', 'delete', '/messages/:messageId'],
  ] as const)('%s → 404 Conversation not found [MG10] [MG13]', async (_label, method, suffix) => {
    const { client, freelancer, project, conversation } = await makeContractScenario();
    const message = await makeMessage(conversation.id, client.id);
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client)[method](
      `/api/conversations/${conversation.id}${suffix.replace(':messageId', message.id)}`,
    ).send({ body: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Conversation not found' } });
    expect(await prisma.message.count()).toBe(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deletedAt).toBeNull();
    const participants = await prisma.conversationParticipant.findMany({ where: { userId: freelancer.id } });
    expect(participants[0].lastReadAt).toBeNull();
  });

  it('GET /api/contracts/:id/conversation → 404 Contract not found [MG10] [MG18]', async () => {
    const { client, project, contract } = await makeContractScenario();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).get(`/api/contracts/${contract.id}/conversation`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Contract not found' } });
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/contracts/:id/conversation
// ---------------------------------------------------------------------------------------------

describe('GET /api/contracts/:id/conversation', () => {
  it('returns { id, unreadCount } to either party [MG18]', async () => {
    const { client, freelancer, contract, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id);

    const asClient = await authed(client).get(`/api/contracts/${contract.id}/conversation`);
    const asFreelancer = await authed(freelancer).get(`/api/contracts/${contract.id}/conversation`);

    expect(asClient.status).toBe(200);
    expect(asClient.body).toEqual({ id: conversation.id, unreadCount: 1 });
    expect(asFreelancer.body).toEqual({ id: conversation.id, unreadCount: 0 });
  });

  it('404s Conversation not found for a contract without one (data repair) [MG18]', async () => {
    const { client, contract, conversation } = await makeContractScenario();
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });

    const res = await authed(client).get(`/api/contracts/${contract.id}/conversation`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Conversation not found' } });
  });

  it('requires a token', async () => {
    expect((await api().get('/api/contracts/x/conversation')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// System messages of plan replacement, automatic approval and the whole lifecycle (MG6, MG7)
// ---------------------------------------------------------------------------------------------

describe('system messages', () => {
  const plan = [{ title: '전체', amount: 4_000_000, dueDate: '2099-01-01' }];

  it('every plan replacement posts MILESTONE_PLAN_UPDATED, signature or not [MG6] [MS8]', async () => {
    const { client, contract, conversation } = await makeContractScenario();

    const unsigned = await authed(client).put(`/api/contracts/${contract.id}/milestones`).send({ milestones: plan });
    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const signed = await authed(client).put(`/api/contracts/${contract.id}/milestones`).send({ milestones: plan });

    expect([unsigned.status, signed.status]).toEqual([200, 200]);
    expect(await systemEvents(conversation.id)).toEqual(['MILESTONE_PLAN_UPDATED', 'MILESTONE_PLAN_UPDATED']);
    // Unlike the notification, which only follows a replacement that cleared a signature.
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_PLAN_UPDATED' } })).toBe(1);
  });

  it('a refused plan replacement posts nothing [MG6] [MS7]', async () => {
    const { client, contract, conversation } = await makeContractScenario({ contract: { status: 'ACTIVE' } });

    const res = await authed(client).put(`/api/contracts/${contract.id}/milestones`).send({ milestones: plan });

    expect(res.status).toBe(409);
    expect(await systemEvents(conversation.id)).toEqual([]);
  });

  /** An ACTIVE contract whose single milestone was submitted through the API. */
  async function submittedViaApi() {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED', fundedAt: new Date() },
    });
    await makePayment(scenario.milestone.id, scenario.client.id, { status: 'COMPLETED' });
    const res = await authed(scenario.freelancer)
      .post(`/api/milestones/${scenario.milestone.id}/submissions`)
      .send({ message: '산출물' });
    expect(res.status).toBe(201);
    const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: scenario.milestone.id } });
    return { ...scenario, autoApproveAt: stored.autoApproveAt! };
  }

  it('automatic approval posts MILESTONE_AUTO_APPROVED then CONTRACT_COMPLETED, on the server clock [MG6] [MG7] [MS20]', async () => {
    const { conversation, autoApproveAt } = await submittedViaApi();

    const before = Date.now();
    await runJobs(autoApproveAt);
    const after = Date.now();

    expect(await systemEvents(conversation.id)).toEqual([
      'MILESTONE_SUBMITTED',
      'MILESTONE_AUTO_APPROVED',
      'CONTRACT_COMPLETED',
    ]);
    // MG7: the job ran with a `now` a week ahead, but messages sort by when they were written.
    const auto = await prisma.message.findFirstOrThrow({ where: { systemEvent: 'MILESTONE_AUTO_APPROVED' } });
    expect(auto.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(auto.createdAt.getTime()).toBeLessThanOrEqual(after);
    expect(auto.createdAt.getTime()).toBeLessThan(autoApproveAt.getTime());
  });

  it('automatic approval of a deleted project posts nothing, like its notifications [MG6] [MS17] [J2]', async () => {
    const { project, contract, conversation, autoApproveAt } = await submittedViaApi();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    await runJobs(autoApproveAt);

    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('COMPLETED');
    expect(await systemEvents(conversation.id)).toEqual(['MILESTONE_SUBMITTED']);
    const [job] = await jobsOf('milestone.autoApprove');
    expect(job.status).toBe('SUCCEEDED');
  });

  it('records the whole lifecycle in order, each event once, all invisible to unread counts [MG6] [MG7] [MG8]', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const project = await makeProject(client.id);
    const application = await makeApplication(project.id, freelancer.id);

    const accepted = await authed(client)
      .patch(`/api/projects/${project.id}/applications/${application.id}`)
      .send({ status: 'ACCEPTED' });
    const contractId = accepted.body.contract.id;
    await authed(client).post(`/api/contracts/${contractId}/sign`);
    await authed(freelancer).post(`/api/contracts/${contractId}/sign`);
    const milestone = await prisma.milestone.findFirstOrThrow({ where: { contractId } });
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED', fundedAt: new Date() } });
    await authed(freelancer).post(`/api/milestones/${milestone.id}/submissions`).send({ message: '1차' });
    await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: '버튼 색을 바꿔주세요.' });
    await authed(freelancer).post(`/api/milestones/${milestone.id}/submissions`).send({ message: '2차' });
    await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    const { id: conversationId } = (await authed(client).get(`/api/contracts/${contractId}/conversation`)).body;
    const res = await authed(freelancer).get(`/api/conversations/${conversationId}/messages`);

    expect(res.body.messages.map((m: { systemEvent: string }) => m.systemEvent)).toEqual([
      'CONTRACT_CREATED',
      'CONTRACT_ACTIVATED',
      'MILESTONE_SUBMITTED',
      'MILESTONE_REVISION_REQUESTED',
      'MILESTONE_SUBMITTED',
      'MILESTONE_APPROVED',
      'CONTRACT_COMPLETED',
    ]);
    for (const m of res.body.messages) {
      expect(m).toMatchObject({ kind: 'SYSTEM', sender: null, deleted: false, readByCounterpart: null });
      expect(m.body.length).toBeGreaterThan(0);
    }
    const times = res.body.messages.map((m: { createdAt: string }) => new Date(m.createdAt).getTime());
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1]);
    expect((await authed(client).get('/api/conversations/unread-count')).body).toEqual({ unreadCount: 0 });
    expect((await authed(freelancer).get('/api/conversations/unread-count')).body).toEqual({ unreadCount: 0 });
    // MG20: system messages are not notifications; and sending none created no digest job.
    expect(await prisma.job.count({ where: { type: 'message.unreadDigest' } })).toBe(0);
  });
});
