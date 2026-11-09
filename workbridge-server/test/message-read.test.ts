import { describe, expect, it, vi } from 'vitest';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { jobsOf, runJobs } from './helpers/jobs';
import { makeContractScenario, makeMessage } from './helpers/factories';
import { enqueueJob } from '../src/jobs/queue';
import { MINUTE_MS } from '../src/lib/time';

/**
 * Unread state — the unread count, `POST /api/conversations/:id/read` and `readByCounterpart` —
 * and the unread-message digest job's first half (deciding whether a digest is due), driven with
 * `runDueJobs({ now })`.
 */

type Scenario = Awaited<ReturnType<typeof makeContractScenario>>;
type User = Scenario['client'];

const read = (user: User, conversationId: string) => authed(user).post(`/api/conversations/${conversationId}/read`);
const unread = async (user: User, conversationId: string) =>
  (await authed(user).get(`/api/conversations/${conversationId}`)).body.conversation.unreadCount as number;
const watermark = async (conversationId: string, userId: string) =>
  (await prisma.conversationParticipant.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId, userId } },
  })).lastReadAt;

const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

// ---------------------------------------------------------------------------------------------
// Unread count
// ---------------------------------------------------------------------------------------------

describe('unread count', () => {
  it('counts the other participant\'s text newer than the watermark — all of it while null', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const first = await makeMessage(conversation.id, freelancer.id, { createdAt: ago(3) });
    await makeMessage(conversation.id, freelancer.id, { createdAt: ago(2) });
    await makeMessage(conversation.id, freelancer.id, { createdAt: ago(1) });

    expect(await unread(client, conversation.id)).toBe(3);

    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: client.id },
      data: { lastReadAt: first.createdAt },
    });
    expect(await unread(client, conversation.id)).toBe(2);
  });

  it('never counts system messages or the caller\'s own', async () => {
    const { client, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, null, { systemEvent: 'MILESTONE_FUNDED' });
    await makeMessage(conversation.id, client.id);

    expect(await unread(client, conversation.id)).toBe(0);
  });

  it('a message deleted after it was counted stops counting', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const message = await makeMessage(conversation.id, freelancer.id);
    expect(await unread(client, conversation.id)).toBe(1);

    await authed(freelancer).delete(`/api/conversations/${conversation.id}/messages/${message.id}`);

    expect(await unread(client, conversation.id)).toBe(0);
    expect((await authed(client).get('/api/conversations/unread-count')).body).toEqual({ unreadCount: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/conversations/:id/read
// ---------------------------------------------------------------------------------------------

describe('POST /api/conversations/:id/read', () => {
  it('moves the watermark to the newest counterpart message and answers { lastReadAt, unreadCount }', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id, { createdAt: ago(3) });
    const newest = await makeMessage(conversation.id, freelancer.id, { createdAt: ago(2) });
    await makeMessage(conversation.id, client.id, { createdAt: ago(1) });

    const res = await read(client, conversation.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastReadAt: newest.createdAt.toISOString(), unreadCount: 0 });
    expect((await watermark(conversation.id, client.id))?.getTime()).toBe(newest.createdAt.getTime());
    expect(await watermark(conversation.id, freelancer.id)).toBeNull();
  });

  it('system messages never move it: a later system message does not mark earlier text read', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const text = await makeMessage(conversation.id, freelancer.id, { createdAt: ago(2) });
    await makeMessage(conversation.id, null, { createdAt: ago(1) });

    const res = await read(client, conversation.id);

    expect(res.body.lastReadAt).toBe(text.createdAt.toISOString());
  });

  it('counts the newest counterpart message even when it was deleted', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id, { createdAt: ago(2) });
    const deleted = await makeMessage(conversation.id, freelancer.id, { createdAt: ago(1), deletedAt: new Date() });

    const res = await read(client, conversation.id);

    expect(res.body.lastReadAt).toBe(deleted.createdAt.toISOString());
  });

  it('without any counterpart message nothing changes', async () => {
    const { client, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, client.id);
    await makeMessage(conversation.id, null);

    const res = await read(client, conversation.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastReadAt: null, unreadCount: 0 });
  });

  it('never moves the watermark back', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeMessage(conversation.id, freelancer.id, { createdAt: ago(5) });
    const ahead = ago(1);
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: client.id },
      data: { lastReadAt: ahead },
    });

    const res = await read(client, conversation.id);

    expect(res.body.lastReadAt).toBe(ahead.toISOString());
  });

  it('concurrent reads are harmless and land on the same watermark', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const newest = await makeMessage(conversation.id, freelancer.id);

    const responses = await Promise.all([read(client, conversation.id), read(client, conversation.id), read(client, conversation.id)]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ lastReadAt: newest.createdAt.toISOString(), unreadCount: 0 });
    }
  });

  it('a message sent after the read is unread again, and the header total follows', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await authed(freelancer).post(`/api/conversations/${conversation.id}/messages`).send({ body: '첫 메시지' });
    await read(client, conversation.id);
    await authed(freelancer).post(`/api/conversations/${conversation.id}/messages`).send({ body: '두 번째' });

    expect(await unread(client, conversation.id)).toBe(1);
    expect((await authed(client).get('/api/conversations/unread-count')).body).toEqual({ unreadCount: 1 });
    expect((await read(client, conversation.id)).body.unreadCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// readByCounterpart
// ---------------------------------------------------------------------------------------------

describe('readByCounterpart', () => {
  it('is true for the caller\'s text the other side has read, false otherwise, null for the rest', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const seen = await makeMessage(conversation.id, client.id, { createdAt: ago(4) });
    const reply = await makeMessage(conversation.id, freelancer.id, { createdAt: ago(3) });
    const unseen = await makeMessage(conversation.id, client.id, { createdAt: ago(2) });
    await makeMessage(conversation.id, null, { createdAt: ago(1) });
    // The freelancer's watermark covers the client's first message only.
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: freelancer.id },
      data: { lastReadAt: seen.createdAt },
    });

    const asClient = await authed(client).get(`/api/conversations/${conversation.id}/messages`);
    const asFreelancer = await authed(freelancer).get(`/api/conversations/${conversation.id}/messages`);

    expect(asClient.body.messages.map((m: { readByCounterpart: boolean | null }) => m.readByCounterpart))
      .toEqual([true, null, false, null]);
    expect(asFreelancer.body.messages.map((m: { readByCounterpart: boolean | null }) => m.readByCounterpart))
      .toEqual([null, false, null, null]);
    expect(asClient.body.messages[1].id).toBe(reply.id);
    expect(asClient.body.messages[2].id).toBe(unseen.id);
  });

  it('flips once the other side reads through the API', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const sent = await authed(client).post(`/api/conversations/${conversation.id}/messages`).send({ body: '확인 부탁드려요' });
    expect(sent.body.message.readByCounterpart).toBe(false);

    await read(freelancer, conversation.id);

    const res = await authed(client).get(`/api/conversations/${conversation.id}/messages`);
    expect(res.body.messages.at(-1)).toMatchObject({ id: sent.body.message.id, readByCounterpart: true });
  });
});

// ---------------------------------------------------------------------------------------------
// message.unreadDigest — is a digest due?
// ---------------------------------------------------------------------------------------------

describe('message.unreadDigest job', () => {
  const sendText = (user: User, conversationId: string, body = '안녕하세요') =>
    authed(user).post(`/api/conversations/${conversationId}/messages`).send({ body });

  const digestsFor = async (recipientId: string) =>
    (await jobsOf('message.unreadDigest')).filter((j) => (j.payload as { recipientId: string }).recipientId === recipientId);

  it('a send enqueues one digest for the other participant at createdAt + 10 min; later sends do not add more', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();

    const first = await sendText(client, conversation.id, '하나');
    await sendText(client, conversation.id, '둘');

    const jobs = await digestsFor(freelancer.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: 'PENDING',
      dedupeKey: null,
      maxAttempts: 5,
      payload: { conversationId: conversation.id, recipientId: freelancer.id },
    });
    expect(jobs[0].runAt.getTime()).toBe(new Date(first.body.message.createdAt).getTime() + 10 * MINUTE_MS);
    expect(await digestsFor(client.id)).toHaveLength(0);
  });

  it('a pending digest for another conversation or recipient does not block one', async () => {
    const a = await makeContractScenario();
    const b = await makeContractScenario({ contract: { clientId: a.client.id } });

    await sendText(a.client, a.conversation.id);
    await sendText(a.client, b.conversation.id);
    await sendText(a.freelancer, a.conversation.id);

    expect(await digestsFor(a.freelancer.id)).toHaveLength(1);
    expect(await digestsFor(b.freelancer.id)).toHaveLength(1);
    expect(await digestsFor(a.client.id)).toHaveLength(1);
  });

  it('runs to SUCCEEDED and creates one email-only digest when the messages are still unread at the due time', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await sendText(client, conversation.id);
    const [job] = await digestsFor(freelancer.id);

    const result = await runJobs(job.runAt);

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await digestsFor(freelancer.id)).toHaveLength(1); // nothing re-enqueued
    expect(await prisma.notification.count()).toBe(0); // email only, never an in-app row
    expect(await prisma.emailDelivery.count({ where: { userId: freelancer.id, type: 'MESSAGE_UNREAD_DIGEST' } })).toBe(1);
    expect(await watermark(conversation.id, freelancer.id)).toBeNull();
  });

  it('is a no-op when the recipient read within 10 minutes', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await sendText(client, conversation.id);
    await read(freelancer, conversation.id);
    const [job] = await digestsFor(freelancer.id);

    await runJobs(job.runAt);

    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await prisma.job.count()).toBe(1);
  });

  it('re-enqueues at the oldest unread message + 10 min when newer messages arrived after a read', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const t0 = Date.now() - 30 * MINUTE_MS;
    // A at t0 enqueued a job for t0 + 10; the recipient read at t0 + 2; B at t0 + 9 enqueued nothing.
    const a = await makeMessage(conversation.id, client.id, { createdAt: new Date(t0) });
    await enqueueJob(prisma, {
      type: 'message.unreadDigest',
      payload: { conversationId: conversation.id, recipientId: freelancer.id },
      runAt: new Date(t0 + 10 * MINUTE_MS),
    });
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: freelancer.id },
      data: { lastReadAt: a.createdAt },
    });
    await makeMessage(conversation.id, client.id, { createdAt: new Date(t0 + 9 * MINUTE_MS) });

    await runJobs(new Date(t0 + 10 * MINUTE_MS));

    const jobs = await digestsFor(freelancer.id);
    expect(jobs.map((j) => [j.status, j.runAt.getTime()])).toEqual([
      ['SUCCEEDED', t0 + 10 * MINUTE_MS],
      ['PENDING', t0 + 19 * MINUTE_MS],
    ]);
    expect(jobs[1].payload).toEqual({ conversationId: conversation.id, recipientId: freelancer.id });

    // At t0 + 19 the message is old enough: the re-check passes and nothing more is enqueued.
    await runJobs(new Date(t0 + 19 * MINUTE_MS));
    expect((await digestsFor(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });

  it('does not re-enqueue when another digest for the pair is already pending', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const t0 = Date.now() - 30 * MINUTE_MS;
    await makeMessage(conversation.id, client.id, { createdAt: new Date(t0 + 9 * MINUTE_MS) });
    const payload = { conversationId: conversation.id, recipientId: freelancer.id };
    await enqueueJob(prisma, { type: 'message.unreadDigest', payload, runAt: new Date(t0 + 10 * MINUTE_MS) });
    await enqueueJob(prisma, { type: 'message.unreadDigest', payload, runAt: new Date(t0 + 60 * MINUTE_MS) });

    await runJobs(new Date(t0 + 10 * MINUTE_MS));

    expect((await digestsFor(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED', 'PENDING']);
  });

  it.each([
    ['the recipient is soft-deleted', 'recipient'],
    ['the project is soft-deleted', 'project'],
  ] as const)('is a no-op when %s', async (_label, what) => {
    const { client, freelancer, project, conversation } = await makeContractScenario();
    await sendText(client, conversation.id);
    const [job] = await digestsFor(freelancer.id);
    if (what === 'recipient') {
      await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });
    } else {
      await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    }

    await runJobs(new Date(job.runAt.getTime() + 60 * MINUTE_MS));

    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await prisma.job.count()).toBe(1);
  });

  it('a payload naming no participant fails permanently, without retrying', async () => {
    const { conversation } = await makeContractScenario();
    await enqueueJob(prisma, {
      type: 'message.unreadDigest',
      payload: { conversationId: conversation.id, recipientId: 'missing-user-id' },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runJobs(new Date());

      expect(result).toMatchObject({ claimed: 1, failed: 1 });
      const [job] = await jobsOf('message.unreadDigest');
      expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(job.lastError).toContain('missing-user-id');
    } finally {
      errors.mockRestore();
    }
  });

  it('serializes with a concurrent read on the participant row: both succeed', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await sendText(client, conversation.id);
    const [job] = await digestsFor(freelancer.id);

    const [result, res] = await Promise.all([runJobs(job.runAt), read(freelancer, conversation.id)]);

    expect(result.succeeded).toBe(1);
    expect(res.status).toBe(200);
    // Either order is consistent: read first → nothing to send; digest first → one email.
    expect(await digestsFor(freelancer.id)).toHaveLength(1);
    const deliveries = await prisma.emailDelivery.findMany({ where: { type: 'MESSAGE_UNREAD_DIGEST' } });
    expect(deliveries.length).toBeLessThanOrEqual(1);
    if (deliveries.length === 1) expect(deliveries[0].userId).toBe(freelancer.id);
    // The read lands in either order. (The delivery's `createdAt` is the job's simulated `now`,
    // ten minutes ahead of the wall clock, so it cannot be ordered against `lastReadAt`.)
    const sent = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, senderId: client.id } });
    expect((await watermark(conversation.id, freelancer.id))!.getTime()).toBeGreaterThanOrEqual(sent.createdAt.getTime());
  });
});
