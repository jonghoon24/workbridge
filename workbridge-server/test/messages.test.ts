import { beforeEach, describe, expect, it, vi } from 'vitest';

// No test may reach Supabase; attachments go through this in-memory storage.
vi.mock('@supabase/supabase-js', async () => {
  const { storage } = await import('./helpers/storageFake.js');
  return { createClient: () => storage.client };
});

import { authed } from './helpers/api';
import { storage } from './helpers/storageFake';
import { ATTACHMENT_BUCKET, pdf, png, uploadFiles } from './helpers/attachments';
import { prisma } from './helpers/db';
import { makeContractScenario, makeMessage } from './helpers/factories';
import { postSystemMessage } from '../src/services/messaging.service';
import { DAY_MS, MINUTE_MS } from '../src/lib/time';
import { invalidBody, invalidBodyFor } from './helpers/errors';
import type { FieldErrorCode } from '../src/lib/errorCodes';

/**
 * Messages — listing, sending, deleting, who may post, and ordering. Unread counts, the read watermark and
 * the digest job are in message-read.test.ts; conversation objects in conversations.test.ts.
 */

beforeEach(() => {
  storage.reset();
});

const files = () => storage.bucket(ATTACHMENT_BUCKET);

type Scenario = Awaited<ReturnType<typeof makeContractScenario>>;
type User = Scenario['client'];

const messagesUrl = (conversationId: string) => `/api/conversations/${conversationId}/messages`;
const send = (user: User, conversationId: string) => authed(user).post(messagesUrl(conversationId));
const list = (user: User, conversationId: string, query = '') =>
  authed(user).get(`${messagesUrl(conversationId)}${query ? `?${query}` : ''}`);
const remove = (user: User, conversationId: string, messageId: string) =>
  authed(user).delete(`${messagesUrl(conversationId)}/${messageId}`);

const ids = (res: { body: { messages: { id: string }[] } }) => res.body.messages.map((m) => m.id);

/** `count` text messages one second apart, oldest first, alternating senders. */
async function history(scenario: Scenario, count: number, start = Date.now() - count * 1000 - 60_000) {
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const sender = i % 2 === 0 ? scenario.client : scenario.freelancer;
    messages.push(await makeMessage(scenario.conversation.id, sender.id, {
      body: `m${i}`,
      createdAt: new Date(start + i * 1000),
    }));
  }
  return messages;
}

/** The same, through `createMany` — for the page-size caps. */
async function bulkHistory(scenario: Scenario, count: number) {
  const start = Date.now() - count * 1000 - 60_000;
  await prisma.message.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      conversationId: scenario.conversation.id,
      senderId: scenario.client.id,
      body: `bulk ${i}`,
      createdAt: new Date(start + i * 1000),
    })),
  });
  await prisma.conversation.update({
    where: { id: scenario.conversation.id },
    data: { lastMessageAt: new Date(start + (count - 1) * 1000) },
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/conversations/:id/messages
// ---------------------------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages', () => {
  it('returns the newest page in ascending order with hasMore', async () => {
    const scenario = await makeContractScenario();
    const messages = await history(scenario, 5);

    const res = await list(scenario.client, scenario.conversation.id, 'limit=3');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'messages']);
    expect(ids(res)).toEqual(messages.slice(2).map((m) => m.id));
    expect(res.body.hasMore).toBe(true);
    expect(Object.keys(res.body.messages[0]).sort()).toEqual([
      'attachments', 'body', 'conversationId', 'createdAt', 'deleted', 'id', 'kind', 'readByCounterpart',
      'sender', 'systemEvent',
    ]);
    expect(res.body.messages[0]).toMatchObject({
      id: messages[2].id,
      conversationId: scenario.conversation.id,
      kind: 'TEXT',
      systemEvent: null,
      sender: { id: scenario.client.id, name: scenario.client.name, profileImage: null },
      body: 'm2',
      deleted: false,
      attachments: [],
      readByCounterpart: false,
    });
    expect(Object.keys(res.body.messages[0].sender).sort()).toEqual(['id', 'name', 'profileImage']);
    expect(res.body.messages[1]).toMatchObject({ body: 'm3', readByCounterpart: null }); // the freelancer's
  });

  it('pages backwards with before, and says when the start is reached', async () => {
    const scenario = await makeContractScenario();
    const messages = await history(scenario, 5);

    const older = await list(scenario.client, scenario.conversation.id, `before=${messages[2].id}&limit=2`);
    const oldest = await list(scenario.client, scenario.conversation.id, `before=${messages[1].id}&limit=2`);

    expect(ids(older)).toEqual([messages[0].id, messages[1].id]);
    expect(older.body.hasMore).toBe(false);
    expect(ids(oldest)).toEqual([messages[0].id]);
    expect(oldest.body.hasMore).toBe(false);
    const more = await list(scenario.client, scenario.conversation.id, `before=${messages[3].id}&limit=2`);
    expect(ids(more)).toEqual([messages[1].id, messages[2].id]);
    expect(more.body.hasMore).toBe(true);
  });

  it('polls forwards with after; hasMore means "ask again at once"', async () => {
    const scenario = await makeContractScenario();
    const messages = await history(scenario, 5);

    const newer = await list(scenario.client, scenario.conversation.id, `after=${messages[0].id}&limit=3`);
    const rest = await list(scenario.client, scenario.conversation.id, `after=${messages[3].id}&limit=3`);
    const none = await list(scenario.client, scenario.conversation.id, `after=${messages[4].id}`);

    expect(ids(newer)).toEqual([messages[1].id, messages[2].id, messages[3].id]);
    expect(newer.body.hasMore).toBe(true);
    expect(ids(rest)).toEqual([messages[4].id]);
    expect(rest.body.hasMore).toBe(false);
    expect(none.body).toEqual({ messages: [], hasMore: false });
  });

  it('orders messages with the same createdAt by id, and cursors respect that tie-break', async () => {
    const scenario = await makeContractScenario();
    const at = new Date(Date.now() - 60_000);
    for (let i = 0; i < 4; i += 1) await makeMessage(scenario.conversation.id, scenario.client.id, { createdAt: at });
    const sorted = (await prisma.message.findMany({ orderBy: { id: 'asc' } })).map((m) => m.id);

    const all = await list(scenario.client, scenario.conversation.id);
    const after = await list(scenario.client, scenario.conversation.id, `after=${sorted[1]}`);
    const before = await list(scenario.client, scenario.conversation.id, `before=${sorted[2]}`);

    expect(ids(all)).toEqual(sorted);
    expect(ids(after)).toEqual(sorted.slice(2));
    expect(ids(before)).toEqual(sorted.slice(0, 2));
  });

  it('includes system messages and tombstones; a deleted message is a valid cursor', async () => {
    const scenario = await makeContractScenario();
    const system = await makeMessage(scenario.conversation.id, null, { createdAt: new Date(Date.now() - 3000) });
    const deleted = await makeMessage(scenario.conversation.id, scenario.freelancer.id, {
      body: 'oops',
      createdAt: new Date(Date.now() - 2000),
      deletedAt: new Date(),
      attachments: [{ fileName: 'x.pdf' }],
    });
    const last = await makeMessage(scenario.conversation.id, scenario.client.id, { createdAt: new Date(Date.now() - 1000) });

    const res = await list(scenario.client, scenario.conversation.id);
    const after = await list(scenario.client, scenario.conversation.id, `after=${deleted.id}`);

    expect(res.body.messages).toMatchObject([
      { id: system.id, kind: 'SYSTEM', systemEvent: 'CONTRACT_CREATED', sender: null, readByCounterpart: null },
      { id: deleted.id, kind: 'TEXT', body: '', deleted: true, attachments: [], sender: { id: scenario.freelancer.id } },
      { id: last.id, deleted: false },
    ]);
    expect(ids(after)).toEqual([last.id]);
  });

  it('defaults to 30 and caps limit at 100', async () => {
    const scenario = await makeContractScenario();
    await bulkHistory(scenario, 101);

    const byDefault = await list(scenario.client, scenario.conversation.id);
    const capped = await list(scenario.client, scenario.conversation.id, 'limit=500');
    const empty = await list(scenario.client, scenario.conversation.id, 'limit=&before=');

    expect(byDefault.body.messages).toHaveLength(30);
    expect(byDefault.body.messages[29].body).toBe('bulk 100');
    expect(capped.body.messages).toHaveLength(100);
    expect(capped.body.hasMore).toBe(true);
    expect(empty.body.messages).toHaveLength(30);
  });

  it.each([
    ['before=a&after=b', 'before: Use either before or after, not both', 'CONFLICT'],
    ['limit=0', 'limit: must be at least 1', 'TOO_SMALL'],
    ['limit=2.5', 'limit: must be an integer', 'INVALID'],
    ['limit=1&limit=2', 'limit: must be a single value', 'INVALID'],
    ['before=a&before=b', 'before: must be a single value', 'INVALID'],
  ] as const)('400s for %s, before looking the conversation up', async (query, message, code) => {
    const { client } = await makeContractScenario();

    const res = await list(client, 'missing-conversation-id', query);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBodyFor(code, message));
  });

  it('400s for a cursor that is not a message of this conversation, after 404/403', async () => {
    const scenario = await makeContractScenario();
    const other = await makeContractScenario();
    const foreign = await makeMessage(other.conversation.id, other.client.id);

    const before = await list(scenario.client, scenario.conversation.id, 'before=missing-message-id');
    const after = await list(scenario.client, scenario.conversation.id, `after=${foreign.id}`);
    const notMine = await list(scenario.client, other.conversation.id, 'after=missing-message-id');

    expect(before.status).toBe(400);
    expect(before.body).toEqual(invalidBody('before', 'INVALID', 'before: Message not found in this conversation'));
    expect(after.body).toEqual(invalidBody('after', 'INVALID', 'after: Message not found in this conversation'));
    expect(notMine.status).toBe(403);
  });

  it('never marks anything read', async () => {
    const scenario = await makeContractScenario();
    await history(scenario, 3);

    await list(scenario.client, scenario.conversation.id);
    await list(scenario.freelancer, scenario.conversation.id);

    const participants = await prisma.conversationParticipant.findMany();
    expect(participants.map((p) => p.lastReadAt)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/conversations/:id/messages
// ---------------------------------------------------------------------------------------------

describe('POST /api/conversations/:id/messages', () => {
  it('posts a trimmed text message: 201, lastMessageAt, digest for the other side, no notification', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const before = Date.now();

    const res = await send(client, conversation.id).send({ body: '  안녕하세요, 일정 공유드립니다.  ' });
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['message']);
    expect(res.body.message).toMatchObject({
      conversationId: conversation.id,
      kind: 'TEXT',
      systemEvent: null,
      sender: { id: client.id, name: client.name, profileImage: null },
      body: '안녕하세요, 일정 공유드립니다.',
      deleted: false,
      attachments: [],
      readByCounterpart: false,
    });
    const createdAt = new Date(res.body.message.createdAt).getTime();
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.lastMessageAt?.getTime()).toBe(createdAt);

    expect(await prisma.notification.count()).toBe(0);
    const jobs = await prisma.job.findMany();
    expect(jobs.map((j) => [j.type, j.payload, j.dedupeKey, j.runAt.getTime()])).toEqual([
      ['message.unreadDigest', { conversationId: conversation.id, recipientId: freelancer.id }, null, createdAt + 10 * MINUTE_MS],
    ]);
    // Sending does not move the sender's own watermark.
    const participants = await prisma.conversationParticipant.findMany();
    expect(participants.every((p) => p.lastReadAt === null)).toBe(true);
  });

  it('attaches uploaded files: rows keep the storage key, the response carries signed URLs', async () => {
    const { freelancer, conversation } = await makeContractScenario();
    const { ids, keys } = await uploadFiles(storage, freelancer, `/api/conversations/${conversation.id}`, [
      pdf('최종 시안.pdf', 8),
      png('shot.png', 3),
    ]);

    const res = await send(freelancer, conversation.id).send({ body: '시안 첨부합니다', uploadIds: ids });

    expect(res.status).toBe(201);
    const { attachments } = res.body.message;
    expect(attachments.map((a: { fileName: string }) => a.fileName)).toEqual(['최종 시안.pdf', 'shot.png']);
    expect(Object.keys(attachments[0]).sort()).toEqual(['createdAt', 'fileName', 'id', 'mimeType', 'size', 'url']);
    expect(attachments[0]).toMatchObject({ mimeType: 'application/pdf', size: 8 });
    for (const key of keys) expect(key).toMatch(new RegExp(`^messages/${conversation.id}/[0-9a-f-]{36}\\.(pdf|png)$`));
    expect(attachments.map((a: { url: string }) => a.url)).toEqual(
      keys.map((key) => expect.stringContaining(`/object/sign/${ATTACHMENT_BUCKET}/${key}?`)),
    );
    // Keyed by name, not ordered by it: Hangul vs Latin order depends on the database collation.
    const stored = await prisma.messageAttachment.findMany();
    expect(Object.fromEntries(stored.map((a) => [a.fileName, [a.storageKey, a.url]]))).toEqual({
      '최종 시안.pdf': [keys[0], null],
      'shot.png': [keys[1], null],
    });
    expect(await prisma.attachmentUpload.count()).toBe(0);
  });

  it('accepts uploads with no body, stored as an empty body', async () => {
    const { client, conversation } = await makeContractScenario();
    const { ids } = await uploadFiles(storage, client, `/api/conversations/${conversation.id}`, [
      { fileName: '메모.txt', mimeType: 'text/plain', size: 1 },
    ]);

    const res = await send(client, conversation.id).send({ uploadIds: ids });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ body: '', attachments: [{ fileName: '메모.txt' }] });
  });

  it('accepts exactly 5000 characters after trimming', async () => {
    const { client, conversation } = await makeContractScenario();

    const res = await send(client, conversation.id).send({ body: `  ${'가'.repeat(5000)}  ` });

    expect(res.status).toBe(201);
    expect(res.body.message.body).toHaveLength(5000);
  });

  it.each<[string, Record<string, unknown>, string, FieldErrorCode]>([
    ['5001 characters', { body: 'a'.repeat(5001) }, 'body: Message must be at most 5000 characters', 'TOO_LARGE'],
    ['an empty body', { body: '' }, 'body: Message or attachment is required', 'REQUIRED'],
    ['only whitespace', { body: ' \n\t ' }, 'body: Message or attachment is required', 'REQUIRED'],
    ['no body at all', {}, 'body: Message or attachment is required', 'REQUIRED'],
    ['a non-string body', { body: 42 }, 'body: Expected string, received number', 'INVALID'],
  ])('400s for %s, before looking the conversation up', async (_label, payload, message, code) => {
    const { client } = await makeContractScenario();

    const res = await send(client, 'missing-conversation-id').send(payload);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBodyFor(code, message));
    expect(await prisma.message.count()).toBe(0);
  });

  it('a storage failure while checking the uploads is a 502 and writes nothing — no message, no job', async () => {
    const { client, conversation } = await makeContractScenario();
    const { ids } = await uploadFiles(storage, client, `/api/conversations/${conversation.id}`, [pdf()]);
    files().info.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('bucket down'), { status: 503, statusCode: '503' }) });

    const res = await send(client, conversation.id).send({ body: 'x', uploadIds: ids });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable' } });
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.attachmentUpload.count()).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).lastMessageAt).toBeNull();
  });

  it('is atomic: a failing digest enqueue leaves no message and no attachment row', async () => {
    const { client, conversation } = await makeContractScenario();
    await prisma.$executeRawUnsafe(`ALTER TABLE "Job" ADD CONSTRAINT "tmp_no_jobs" CHECK (false) NOT VALID`);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { ids } = await uploadFiles(storage, client, `/api/conversations/${conversation.id}`, [pdf()]);
      const res = await send(client, conversation.id).send({ body: 'x', uploadIds: ids });

      expect(res.status).toBe(500);
      expect(await prisma.message.count()).toBe(0);
      expect(await prisma.messageAttachment.count()).toBe(0);
      // The upload was not consumed either: it can still be attached.
      expect(await prisma.attachmentUpload.count()).toBe(1);
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).lastMessageAt).toBeNull();
    } finally {
      logs.mockRestore();
      await prisma.$executeRawUnsafe(`ALTER TABLE "Job" DROP CONSTRAINT "tmp_no_jobs"`);
    }
  });

  describe('who may post', () => {
    it.each([
      ['PENDING', {}],
      ['ACTIVE', {}],
      ['COMPLETED one hour before closing', { completedAt: new Date(Date.now() - 30 * DAY_MS + 3_600_000) }],
    ] as const)('allows a %s contract', async (label, extra) => {
      const status = label.split(' ')[0] as 'PENDING' | 'ACTIVE' | 'COMPLETED';
      const { client, freelancer, conversation } = await makeContractScenario({ contract: { status, ...extra } });

      expect((await send(client, conversation.id).send({ body: 'a' })).status).toBe(201);
      expect((await send(freelancer, conversation.id).send({ body: 'b' })).status).toBe(201);
    });

    it('allows a CANCELLED contract within the window and 409s after it, like a completed one', async () => {
      const open = await makeContractScenario({
        contract: { status: 'CANCELLED', cancelledAt: new Date(Date.now() - 30 * DAY_MS + 3_600_000) },
      });
      const closed = await makeContractScenario({
        contract: { status: 'CANCELLED', cancelledAt: new Date(Date.now() - 30 * DAY_MS - 1000) },
      });

      expect((await send(open.freelancer, open.conversation.id).send({ body: '철회 사유를 여쭤봐도 될까요?' })).status).toBe(201);
      const late = await send(closed.client, closed.conversation.id).send({ body: 'x' });
      expect(late.status).toBe(409);
      expect(late.body).toEqual({ error: { code: 'CONVERSATION_CLOSED', message: 'This conversation is closed' } });
    });

    it('409s once the post-completion window has closed, for either party', async () => {
      const { client, freelancer, conversation } = await makeContractScenario({
        contract: { status: 'COMPLETED', completedAt: new Date(Date.now() - 30 * DAY_MS - 1000) },
      });

      const asClient = await send(client, conversation.id).send({ body: 'still there?' });
      const asFreelancer = await authed(freelancer)
        .post(`/api/conversations/${conversation.id}/uploads`)
        .send({ files: [pdf()] });

      for (const res of [asClient, asFreelancer]) {
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: { code: 'CONVERSATION_CLOSED', message: 'This conversation is closed' } });
      }
      expect(await prisma.message.count()).toBe(0);
      expect(files().createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'ACTIVE'] as const)('409s to a soft-deleted counterpart on a %s contract', async (status) => {
      const { client, freelancer, conversation } = await makeContractScenario({ contract: { status } });
      await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

      const res = await send(client, conversation.id).send({ body: 'hello?' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'COUNTERPART_INACTIVE', message: 'The other participant is no longer active' } });
      expect(await prisma.job.count()).toBe(0);
    });

    it('reports the closed conversation first when both rows match', async () => {
      const { client, freelancer, conversation } = await makeContractScenario({
        contract: { status: 'COMPLETED', completedAt: new Date(Date.now() - 40 * DAY_MS) },
      });
      await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

      const res = await send(client, conversation.id).send({ body: 'x' });

      expect(res.body).toEqual({ error: { code: 'CONVERSATION_CLOSED', message: 'This conversation is closed' } });
    });

    it('a closed conversation still reads, marks read and deletes own messages within the window', async () => {
      const { client, freelancer, conversation } = await makeContractScenario({
        contract: { status: 'COMPLETED', completedAt: new Date(Date.now() - 31 * DAY_MS) },
      });
      await makeMessage(conversation.id, freelancer.id, { createdAt: new Date(Date.now() - 2000) });
      const mine = await makeMessage(conversation.id, client.id, { createdAt: new Date(Date.now() - 1000) });

      expect((await list(client, conversation.id)).status).toBe(200);
      expect((await authed(client).post(`/api/conversations/${conversation.id}/read`)).status).toBe(200);
      expect((await remove(client, conversation.id, mine.id)).status).toBe(200);
    });

    it('system messages are posted even after the conversation closes to people', async () => {
      const { contract, conversation } = await makeContractScenario({
        contract: { status: 'COMPLETED', completedAt: new Date(Date.now() - 40 * DAY_MS) },
      });

      await prisma.$transaction((tx) => postSystemMessage(tx, contract.id, 'CONTRACT_COMPLETED'));

      const [message] = await prisma.message.findMany({ where: { conversationId: conversation.id } });
      expect(message).toMatchObject({ kind: 'SYSTEM', systemEvent: 'CONTRACT_COMPLETED', senderId: null });
    });
  });

  describe('ordering', () => {
    it('concurrent sends get strictly increasing createdAt, and lastMessageAt is the newest', async () => {
      const { client, freelancer, conversation } = await makeContractScenario();
      await Promise.all([1, 2, 3].map(() => list(client, conversation.id)));

      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => send(i % 2 ? client : freelancer, conversation.id).send({ body: `동시 ${i}` })),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(12).fill(201));
      const stored = await prisma.message.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const times = stored.map((m) => m.createdAt.getTime());
      expect(new Set(times).size).toBe(12);
      for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1]);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.lastMessageAt?.getTime()).toBe(times[11]);
      // A poller holding the first message as its cursor sees every later one exactly once.
      const polled = await list(client, conversation.id, `after=${stored[0].id}`);
      expect(ids(polled)).toEqual(stored.slice(1).map((m) => m.id));
      // One pending digest per recipient, not one per message (the digest's enqueue rule).
      const digests = await prisma.job.findMany({ where: { type: 'message.unreadDigest' } });
      expect(digests.map((j) => (j.payload as { recipientId: string }).recipientId).sort())
        .toEqual([client.id, freelancer.id].sort());
    });

    it('never goes back in time: createdAt is at least lastMessageAt + 1 ms', async () => {
      const { client, conversation } = await makeContractScenario();
      const ahead = new Date(Date.now() + 60 * MINUTE_MS);
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: ahead } });

      const res = await send(client, conversation.id).send({ body: 'x' });

      expect(new Date(res.body.message.createdAt).getTime()).toBe(ahead.getTime() + 1);
      const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(stored.lastMessageAt?.getTime()).toBe(ahead.getTime() + 1);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// DELETE /api/conversations/:id/messages/:messageId
// ---------------------------------------------------------------------------------------------

describe('DELETE /api/conversations/:id/messages/:messageId', () => {
  it('soft-deletes the sender\'s message within 5 minutes and returns the tombstone', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const message = await makeMessage(conversation.id, client.id, {
      body: '잘못 보냄',
      createdAt: new Date(Date.now() - 4 * MINUTE_MS),
      attachments: [{ fileName: '계약서.pdf' }],
    });
    const lastMessageAt = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).lastMessageAt;

    const res = await remove(client, conversation.id, message.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: expect.objectContaining({ id: message.id, body: '', deleted: true, attachments: [], kind: 'TEXT' }),
    });
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.body).toBe('잘못 보냄'); // soft: the row stays
    expect(await prisma.messageAttachment.count()).toBe(1);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.lastMessageAt?.getTime()).toBe(lastMessageAt?.getTime());
    // The other side sees the tombstone too.
    const seen = await list(freelancer, conversation.id);
    expect(seen.body.messages[0]).toMatchObject({ id: message.id, body: '', deleted: true, attachments: [] });
  });

  it('409s at and after 5 minutes', async () => {
    const { client, conversation } = await makeContractScenario();
    const old = await makeMessage(conversation.id, client.id, { createdAt: new Date(Date.now() - 5 * MINUTE_MS - 1) });

    const res = await remove(client, conversation.id, old.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'MESSAGE_DELETE_WINDOW_EXPIRED', message: 'Messages can only be deleted within 5 minutes' } });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: old.id } })).deletedAt).toBeNull();
  });

  it('is idempotent: an already deleted message is 200, even after the window', async () => {
    const { client, conversation } = await makeContractScenario();
    const deletedAt = new Date(Date.now() - 60 * MINUTE_MS);
    const message = await makeMessage(conversation.id, client.id, { createdAt: new Date(Date.now() - 61 * MINUTE_MS), deletedAt });

    const res = await remove(client, conversation.id, message.id);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: message.id, deleted: true });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deletedAt?.getTime()).toBe(deletedAt.getTime());
  });

  it('403s for a system message', async () => {
    const { client, conversation } = await makeContractScenario();
    const system = await makeMessage(conversation.id, null);

    const res = await remove(client, conversation.id, system.id);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN_RESOURCE', message: 'Not authorized' } });
  });

  it('two concurrent deletes both answer 200 with one deletion', async () => {
    const { client, conversation } = await makeContractScenario();
    const message = await makeMessage(conversation.id, client.id);

    const responses = await Promise.all([remove(client, conversation.id, message.id), remove(client, conversation.id, message.id)]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.message.count({ where: { deletedAt: { not: null } } })).toBe(1);
  });
});
