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
import { makeContractScenario, makeMessage, makePayment, makeSubmission } from './helpers/factories';
import { runDueJobs } from '../src/jobs/runner';
import { legacyKeyOf, migrateLegacyAttachments } from '../src/services/attachments.service';
import { HOUR_MS, MINUTE_MS } from '../src/lib/time';

/**
 * Message and submission attachments in the private bucket (docs/domain/messaging-notifications.md
 * "첨부 파일"): issuing upload URLs, claiming uploads by id, signed reads, the download routes,
 * deleting a message's files and sweeping expired uploads. The message and submission routes
 * themselves are in messages.test.ts and milestones.test.ts; 401/403/404 lookups in
 * authorization.test.ts.
 */

const MB = 1024 * 1024;

beforeEach(() => {
  storage.reset();
});

const files = () => storage.bucket(ATTACHMENT_BUCKET);
const storageDown = () => ({ data: null, error: Object.assign(new Error('bucket down'), { status: 503, statusCode: '503' }) }) as never;

type Scenario = Awaited<ReturnType<typeof makeContractScenario>>;

const conversationPath = (s: Scenario) => `/api/conversations/${s.conversation.id}`;

/** An ACTIVE contract whose single milestone is FUNDED. */
async function funded() {
  const scenario = await makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    milestone: { status: 'FUNDED', fundedAt: new Date() },
  });
  await makePayment(scenario.milestone.id, scenario.client.id, { status: 'COMPLETED' });
  return scenario;
}

// ---------------------------------------------------------------------------------------------
// Issuing upload URLs
// ---------------------------------------------------------------------------------------------

describe('POST /api/conversations/:id/uploads', () => {
  it('issues one signed upload URL per file under messages/<id>/ and records the uploads', async () => {
    const scenario = await makeContractScenario();
    const now = Date.now();

    const res = await authed(scenario.client)
      .post(`${conversationPath(scenario)}/uploads`)
      .send({ files: [pdf('견적서 최종본.pdf', 1234), png('shot.png', 10)] });

    expect(res.status).toBe(201);
    expect(res.body.uploads).toHaveLength(2);
    const [first, second] = res.body.uploads;
    expect(first).toMatchObject({ fileName: '견적서 최종본.pdf', mimeType: 'application/pdf', size: 1234 });
    expect(first.uploadUrl).toMatch(
      new RegExp(`/object/upload/sign/${ATTACHMENT_BUCKET}/messages/${scenario.conversation.id}/[0-9a-f-]{36}\\.pdf\\?token=`),
    );
    expect(second.uploadUrl).toMatch(/\.png\?token=/);
    expect(new Date(first.expiresAt).getTime() - now).toBeGreaterThanOrEqual(2 * HOUR_MS - 5000);
    expect(new Date(first.expiresAt).getTime() - now).toBeLessThanOrEqual(2 * HOUR_MS + 5000);

    const rows = await prisma.attachmentUpload.findMany({ orderBy: { fileName: 'asc' } });
    expect(rows.map((r) => [r.userId, r.scope, r.targetId])).toEqual([
      [scenario.client.id, 'MESSAGE', scenario.conversation.id],
      [scenario.client.id, 'MESSAGE', scenario.conversation.id],
    ]);
    // The key is ASCII and never carries the original name.
    expect(rows.every((r) => /^[\x20-\x7e]+$/.test(r.storageKey))).toBe(true);
    expect(files().createSignedUploadUrl).toHaveBeenCalledTimes(2);
  });

  it('accepts a file of exactly 10 MB', async () => {
    const scenario = await makeContractScenario();

    const res = await authed(scenario.client).post(`${conversationPath(scenario)}/uploads`).send({ files: [pdf('a.pdf', 10 * MB)] });

    expect(res.status).toBe(201);
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    ['a file over 10 MB', { files: [pdf('a.pdf', 10 * MB + 1)] }, 413, 'File too large (max 10MB)'],
    ['a disallowed type', { files: [{ fileName: 'setup.exe', mimeType: 'application/x-msdownload', size: 2 }] }, 400, 'Unsupported file type: application/x-msdownload'],
    ['an unknown type', { files: [{ fileName: 'x.bin', mimeType: 'application/octet-stream', size: 2 }] }, 400, 'Unsupported file type: application/octet-stream'],
    ['six files', { files: Array.from({ length: 6 }, (_, i) => pdf(`${i}.pdf`)) }, 400, 'files: Too many files (max 5)'],
    ['no files', { files: [] }, 400, 'files: At least one file is required'],
    ['a missing list', {}, 400, 'files: At least one file is required'],
    ['a fractional size', { files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 1.5 }] }, 400, 'files.0.size: File size must be a whole number of bytes'],
    ['a blank name', { files: [{ fileName: ' ', mimeType: 'application/pdf', size: 1 }] }, 400, 'files.0.fileName: File name is required'],
  ])('rejects %s before looking the conversation up', async (_label, body, status, message) => {
    const { client } = await makeContractScenario();

    const res = await authed(client).post('/api/conversations/missing-conversation-id/uploads').send(body);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { message } });
    expect(files().createSignedUploadUrl).not.toHaveBeenCalled();
    expect(await prisma.attachmentUpload.count()).toBe(0);
  });

  it('409s when the caller may no longer post', async () => {
    const scenario = await makeContractScenario();
    await prisma.user.update({ where: { id: scenario.freelancer.id }, data: { deletedAt: new Date() } });

    const res = await authed(scenario.client).post(`${conversationPath(scenario)}/uploads`).send({ files: [pdf()] });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'The other participant is no longer active' } });
    expect(await prisma.attachmentUpload.count()).toBe(0);
  });

  it('a storage failure is a 502 and records nothing', async () => {
    const scenario = await makeContractScenario();
    files().createSignedUploadUrl.mockResolvedValueOnce(storageDown());

    const res = await authed(scenario.client).post(`${conversationPath(scenario)}/uploads`).send({ files: [pdf()] });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { message: 'File upload failed' } });
    expect(await prisma.attachmentUpload.count()).toBe(0);
  });
});

describe('POST /api/milestones/:id/uploads', () => {
  it('issues upload URLs under milestones/<id>/ for the contract\'s freelancer', async () => {
    const { freelancer, milestone } = await funded();

    const res = await authed(freelancer).post(`/api/milestones/${milestone.id}/uploads`).send({ files: [pdf()] });

    expect(res.status).toBe(201);
    expect(res.body.uploads[0].uploadUrl).toContain(`/${ATTACHMENT_BUCKET}/milestones/${milestone.id}/`);
    const row = await prisma.attachmentUpload.findFirstOrThrow();
    expect(row).toMatchObject({ userId: freelancer.id, scope: 'MILESTONE_SUBMISSION', targetId: milestone.id });
  });

  it('409s when the milestone is not awaiting a submission', async () => {
    const { freelancer, milestone } = await funded();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });

    const res = await authed(freelancer).post(`/api/milestones/${milestone.id}/uploads`).send({ files: [pdf()] });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Milestone is not awaiting a submission' } });
  });

  it('checks the file policy before the milestone exists', async () => {
    const { freelancer } = await funded();

    const res = await authed(freelancer).post('/api/milestones/missing-milestone-id/uploads').send({ files: [pdf('a.pdf', 11 * MB)] });

    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------------------------
// Claiming uploads
// ---------------------------------------------------------------------------------------------

describe('claiming uploads on a message', () => {
  const sendMessage = (s: Scenario, user: Scenario['client'], uploadIds: string[], body = '') =>
    authed(user).post(`${conversationPath(s)}/messages`).send({ body, uploadIds });

  it('stores the real size and type read from storage, not the declared ones', async () => {
    const scenario = await makeContractScenario();
    const { ids, keys } = await uploadFiles(storage, scenario.client, conversationPath(scenario), [pdf('a.pdf', 10)]);
    storage.put(ATTACHMENT_BUCKET, keys[0], { size: 777, contentType: 'application/pdf' });

    const res = await sendMessage(scenario, scenario.client, ids);

    expect(res.status).toBe(201);
    expect(res.body.message.attachments[0]).toMatchObject({ size: 777, mimeType: 'application/pdf' });
    expect(files().info).toHaveBeenCalledWith(keys[0]);
  });

  it.each<[string, (s: Scenario, ids: string[]) => Promise<unknown>]>([
    ['issued to the other participant', async () => undefined],
    ['already attached', async (s, ids) => sendMessage(s, s.freelancer, ids, 'first')],
    ['expired', async () => prisma.attachmentUpload.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })],
  ])('400s for an upload %s', async (label, prepare) => {
    const scenario = await makeContractScenario();
    const { ids } = await uploadFiles(storage, scenario.freelancer, conversationPath(scenario), [pdf()]);
    await prepare(scenario, ids);
    const caller = label.startsWith('issued') ? scenario.client : scenario.freelancer;

    const res = await sendMessage(scenario, caller, ids, 'second');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'uploadIds: Upload not found or expired' } });
    expect(await prisma.message.count({ where: { body: 'second' } })).toBe(0);
  });

  it('400s for an upload issued for another conversation', async () => {
    const first = await makeContractScenario();
    // The same client on a second contract.
    const second = await makeContractScenario();
    await prisma.contract.update({ where: { id: second.contract.id }, data: { clientId: first.client.id } });
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: second.conversation.id, userId: second.client.id },
      data: { userId: first.client.id },
    });
    const { ids } = await uploadFiles(storage, first.client, conversationPath(first), [pdf()]);

    const res = await sendMessage(second, first.client, ids, 'elsewhere');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'uploadIds: Upload not found or expired' } });
  });

  it('400s when the file was never uploaded, and the upload stays claimable', async () => {
    const scenario = await makeContractScenario();
    const issued = await authed(scenario.client).post(`${conversationPath(scenario)}/uploads`).send({ files: [pdf()] });
    const ids = issued.body.uploads.map((u: { id: string }) => u.id);

    const res = await sendMessage(scenario, scenario.client, ids, 'where is it');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'uploadIds: File has not been uploaded' } });
    expect(await prisma.message.count({ where: { body: 'where is it' } })).toBe(0);
    expect(await prisma.attachmentUpload.count()).toBe(1);
  });

  it.each<[string, { size: number; contentType: string }, number, string]>([
    ['a stored file over 10 MB', { size: 10 * MB + 1, contentType: 'application/pdf' }, 413, 'File too large (max 10MB)'],
    ['a stored file of a disallowed type', { size: 10, contentType: 'application/x-msdownload' }, 400, 'Unsupported file type: application/x-msdownload'],
  ])('rejects %s even though the declaration passed', async (_label, object, status, message) => {
    const scenario = await makeContractScenario();
    const { ids, keys } = await uploadFiles(storage, scenario.client, conversationPath(scenario), [pdf()]);
    storage.put(ATTACHMENT_BUCKET, keys[0], object);

    const res = await sendMessage(scenario, scenario.client, ids);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.messageAttachment.count()).toBe(0);
  });

  it.each<[string, unknown, string]>([
    ['six uploads', ['1', '2', '3', '4', '5', '6'], 'uploadIds: Too many files (max 5)'],
    ['a repeated upload', ['same', 'same'], 'uploadIds: Upload ids must be unique'],
    ['a non-list', 'one-id', 'uploadIds: Upload ids must be a list'],
  ])('400s for %s before any lookup', async (_label, uploadIds, message) => {
    const { client } = await makeContractScenario();

    const res = await authed(client).post('/api/conversations/missing-conversation-id/messages').send({ body: 'x', uploadIds });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
  });
});

describe('claiming uploads on a submission', () => {
  it('400s for an upload issued for a message, not this milestone', async () => {
    const scenario = await funded();
    const { ids } = await uploadFiles(storage, scenario.freelancer, conversationPath(scenario), [pdf()]);

    const res = await authed(scenario.freelancer)
      .post(`/api/milestones/${scenario.milestone.id}/submissions`)
      .send({ message: 'done', uploadIds: ids });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'uploadIds: Upload not found or expired' } });
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: scenario.milestone.id } })).status).toBe('FUNDED');
  });
});

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

describe('reading attachments', () => {
  it('signs private files for 15 minutes and passes a legacy public URL through', async () => {
    const scenario = await makeContractScenario();
    const legacyUrl = 'https://test.supabase.co/storage/v1/object/public/workbridge/messages/old.pdf';
    await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: legacyUrl, fileName: 'old.pdf' }],
      createdAt: new Date(Date.now() - 2000),
    });
    await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/new.pdf', fileName: 'new.pdf' }],
      createdAt: new Date(Date.now() - 1000),
    });

    const res = await authed(scenario.freelancer).get(`${conversationPath(scenario)}/messages`);

    expect(res.status).toBe(200);
    const [old, fresh] = res.body.messages;
    expect(old.attachments[0].url).toBe(legacyUrl);
    expect(fresh.attachments[0].url).toBe(
      `https://test.supabase.co/storage/v1/object/sign/${ATTACHMENT_BUCKET}/messages/x/new.pdf?token=read-token&expiresIn=900`,
    );
    expect(Object.keys(fresh.attachments[0]).sort()).toEqual(['createdAt', 'fileName', 'id', 'mimeType', 'size', 'url']);
    // One storage call for the whole page.
    expect(files().createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it('still answers when signing fails: the URL is null', async () => {
    const scenario = await makeContractScenario();
    await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/new.pdf', fileName: 'new.pdf' }],
    });
    files().createSignedUrls.mockResolvedValueOnce(storageDown());

    const res = await authed(scenario.client).get(`${conversationPath(scenario)}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].attachments[0]).toMatchObject({ fileName: 'new.pdf', url: null });
  });

  it('signs the last message in the conversation list', async () => {
    const scenario = await makeContractScenario();
    await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/last.pdf', fileName: 'last.pdf' }],
    });

    const res = await authed(scenario.client).get('/api/conversations');

    expect(res.status).toBe(200);
    expect(res.body.conversations[0].lastMessage.attachments[0].url).toContain('/object/sign/');
  });

  it('signs submission files in the milestone detail, the contract milestones and the contract', async () => {
    const scenario = await funded();
    await prisma.milestone.update({ where: { id: scenario.milestone.id }, data: { status: 'SUBMITTED' } });
    const submission = await makeSubmission(scenario.milestone.id);
    await prisma.milestoneAttachment.create({
      data: { submissionId: submission.id, storageKey: 'milestones/x/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf', size: 3 },
    });

    const detail = await authed(scenario.client).get(`/api/milestones/${scenario.milestone.id}`);
    const plan = await authed(scenario.client).get(`/api/contracts/${scenario.contract.id}/milestones`);
    const contract = await authed(scenario.client).get(`/api/contracts/${scenario.contract.id}`);

    for (const res of [detail, plan, contract]) expect(res.status).toBe(200);
    expect(detail.body.submissions[0].attachments[0].url).toContain(`/object/sign/${ATTACHMENT_BUCKET}/milestones/x/a.pdf?`);
    expect(detail.body.latestSubmission.attachments[0].url).toContain('/object/sign/');
    expect(plan.body.milestones[0].latestSubmission.attachments[0].url).toContain('/object/sign/');
    expect(contract.body.milestones[0].latestSubmission.attachments[0].url).toContain('/object/sign/');
  });
});

describe('GET /api/conversations/:id/attachments/:attachmentId/download', () => {
  it('gives a 60-second URL that downloads under the original name', async () => {
    const scenario = await makeContractScenario();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/a.pdf', fileName: '견적서.pdf' }],
    });
    const before = Date.now();

    const res = await authed(scenario.freelancer)
      .get(`${conversationPath(scenario)}/attachments/${message.attachments[0].id}/download`);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(
      `https://test.supabase.co/storage/v1/object/sign/${ATTACHMENT_BUCKET}/messages/x/a.pdf`
      + `?token=download-token&expiresIn=60&download=${encodeURIComponent('견적서.pdf')}`,
    );
    const expiresAt = new Date(res.body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('gives a legacy attachment its public URL with no expiry', async () => {
    const scenario = await makeContractScenario();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: 'https://legacy.test/a.pdf' }],
    });

    const res = await authed(scenario.client)
      .get(`${conversationPath(scenario)}/attachments/${message.attachments[0].id}/download`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://legacy.test/a.pdf', expiresAt: null });
  });

  it('404s for a deleted message\'s attachment and for another conversation\'s', async () => {
    const scenario = await makeContractScenario();
    const other = await makeContractScenario();
    const deleted = await makeMessage(scenario.conversation.id, scenario.client.id, {
      deletedAt: new Date(),
      attachments: [{ url: null, storageKey: 'messages/x/gone.pdf' }],
    });
    const elsewhere = await makeMessage(other.conversation.id, other.client.id, {
      attachments: [{ url: null, storageKey: 'messages/y/other.pdf' }],
    });

    const gone = await authed(scenario.client).get(`${conversationPath(scenario)}/attachments/${deleted.attachments[0].id}/download`);
    const foreign = await authed(scenario.client).get(`${conversationPath(scenario)}/attachments/${elsewhere.attachments[0].id}/download`);

    for (const res of [gone, foreign]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Attachment not found' } });
    }
    expect(files().createSignedUrl).not.toHaveBeenCalled();
  });

  it('a storage failure is a 502', async () => {
    const scenario = await makeContractScenario();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/a.pdf' }],
    });
    files().createSignedUrl.mockResolvedValueOnce(storageDown());

    const res = await authed(scenario.client).get(`${conversationPath(scenario)}/attachments/${message.attachments[0].id}/download`);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { message: 'File storage is unavailable' } });
  });
});

describe('GET /api/milestones/:id/attachments/:attachmentId/download', () => {
  it('serves any round to either party, and 404s for another milestone\'s attachment', async () => {
    const scenario = await funded();
    const other = await funded();
    const submission = await makeSubmission(scenario.milestone.id);
    const attachment = await prisma.milestoneAttachment.create({
      data: { submissionId: submission.id, storageKey: 'milestones/x/a.zip', fileName: '소스.zip', mimeType: 'application/zip', size: 3 },
    });

    const asClient = await authed(scenario.client).get(`/api/milestones/${scenario.milestone.id}/attachments/${attachment.id}/download`);
    const asFreelancer = await authed(scenario.freelancer).get(`/api/milestones/${scenario.milestone.id}/attachments/${attachment.id}/download`);
    const wrongMilestone = await authed(other.client).get(`/api/milestones/${other.milestone.id}/attachments/${attachment.id}/download`);

    expect(asClient.status).toBe(200);
    expect(asClient.body.url).toContain(`download=${encodeURIComponent('소스.zip')}`);
    expect(asFreelancer.status).toBe(200);
    expect(wrongMilestone.status).toBe(404);
    expect(wrongMilestone.body).toEqual({ error: { message: 'Attachment not found' } });
  });
});

// ---------------------------------------------------------------------------------------------
// Deleting files
// ---------------------------------------------------------------------------------------------

describe('deleting a message removes its files', () => {
  it('enqueues the removal with the deletion; the job removes the objects', async () => {
    const scenario = await makeContractScenario();
    const { ids, keys } = await uploadFiles(storage, scenario.client, conversationPath(scenario), [pdf(), png()]);
    const sent = await authed(scenario.client).post(`${conversationPath(scenario)}/messages`).send({ uploadIds: ids });

    const res = await authed(scenario.client).delete(`${conversationPath(scenario)}/messages/${sent.body.message.id}`);

    expect(res.status).toBe(200);
    const jobs = await prisma.job.findMany({ where: { type: 'attachment.deleteObjects' } });
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { keys: string[] }).keys.sort()).toEqual([...keys].sort());
    // The rows stay, hidden behind the tombstone.
    expect(await prisma.messageAttachment.count()).toBe(2);

    await runDueJobs({ now: new Date(), types: ['attachment.deleteObjects'] });

    expect(files().remove).toHaveBeenCalledTimes(1);
    for (const key of keys) expect(storage.has(ATTACHMENT_BUCKET, key)).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobs[0].id } })).status).toBe('SUCCEEDED');
  });

  it('enqueues nothing for a legacy attachment or a repeated delete', async () => {
    const scenario = await makeContractScenario();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, { attachments: [{ fileName: 'old.pdf' }] });
    const url = `${conversationPath(scenario)}/messages/${message.id}`;

    await authed(scenario.client).delete(url);
    await authed(scenario.client).delete(url);

    expect(await prisma.job.count({ where: { type: 'attachment.deleteObjects' } })).toBe(0);
  });

  it('a storage failure leaves the job to retry', async () => {
    const scenario = await makeContractScenario();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: null, storageKey: 'messages/x/a.pdf' }],
    });
    await authed(scenario.client).delete(`${conversationPath(scenario)}/messages/${message.id}`);
    files().remove.mockResolvedValueOnce(storageDown());
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runDueJobs({ now: new Date(), types: ['attachment.deleteObjects'] });

      expect(result.retried).toBe(1);
    } finally {
      logs.mockRestore();
    }
  });
});

describe('maintenance.cleanup sweeps expired uploads', () => {
  it('deletes uploads past their expiry and enqueues the removal of their files; live uploads stay', async () => {
    const scenario = await makeContractScenario();
    const now = new Date();
    await prisma.attachmentUpload.createMany({
      data: [
        { userId: scenario.client.id, scope: 'MESSAGE', targetId: scenario.conversation.id, storageKey: 'messages/x/old.pdf', fileName: 'old.pdf', mimeType: 'application/pdf', size: 1, expiresAt: new Date(now.getTime() - MINUTE_MS) },
        { userId: scenario.client.id, scope: 'MESSAGE', targetId: scenario.conversation.id, storageKey: 'messages/x/live.pdf', fileName: 'live.pdf', mimeType: 'application/pdf', size: 1, expiresAt: new Date(now.getTime() + HOUR_MS) },
      ],
    });
    await prisma.job.create({ data: { type: 'maintenance.cleanup', payload: {}, runAt: now } });

    await runDueJobs({ now, types: ['maintenance.cleanup'] });

    expect((await prisma.attachmentUpload.findMany()).map((u) => u.storageKey)).toEqual(['messages/x/live.pdf']);
    const removal = await prisma.job.findFirstOrThrow({ where: { type: 'attachment.deleteObjects' } });
    expect(removal.payload).toEqual({ keys: ['messages/x/old.pdf'] });
  });
});

describe('migrating legacy attachments to the private bucket', () => {
  const PUBLIC = 'https://test.supabase.co/storage/v1/object/public/workbridge';

  it('reads the key of a public-bucket URL and nothing else', () => {
    expect(legacyKeyOf(`${PUBLIC}/messages/c1/a.pdf`)).toBe('messages/c1/a.pdf');
    expect(legacyKeyOf('https://placehold.co/600x400?text=x')).toBeNull();
    expect(legacyKeyOf('https://test.supabase.co/storage/v1/object/public/other/messages/a.pdf')).toBeNull();
  });

  it('counts without --apply, then copies each file and points its row at the private bucket', async () => {
    const scenario = await funded();
    const message = await makeMessage(scenario.conversation.id, scenario.client.id, {
      attachments: [{ url: `${PUBLIC}/messages/c1/a.pdf` }, { url: 'https://placehold.co/1x1' }],
    });
    const submission = await makeSubmission(scenario.milestone.id);
    await prisma.milestoneAttachment.create({
      data: { submissionId: submission.id, url: `${PUBLIC}/milestones/m1/b.zip`, fileName: 'b.zip', mimeType: 'application/zip', size: 1 },
    });
    storage.put('workbridge', 'messages/c1/a.pdf', { size: 1024, contentType: 'application/pdf' });
    storage.put('workbridge', 'milestones/m1/b.zip', { size: 1, contentType: 'application/zip' });

    const dry = await migrateLegacyAttachments({ apply: false });

    expect(dry).toEqual({ found: 2, migrated: 0, skipped: 1, failed: [] });
    expect(await prisma.messageAttachment.count({ where: { storageKey: { not: null } } })).toBe(0);

    const applied = await migrateLegacyAttachments({ apply: true });
    const again = await migrateLegacyAttachments({ apply: true });

    expect(applied).toEqual({ found: 2, migrated: 2, skipped: 1, failed: [] });
    expect(again).toEqual({ found: 0, migrated: 0, skipped: 1, failed: [] });
    expect(storage.has(ATTACHMENT_BUCKET, 'messages/c1/a.pdf')).toBe(true);
    expect(storage.has(ATTACHMENT_BUCKET, 'milestones/m1/b.zip')).toBe(true);
    const moved = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: message.id, storageKey: { not: null } } });
    expect(moved).toMatchObject({ storageKey: 'messages/c1/a.pdf', url: null });
    expect(await prisma.milestoneAttachment.findFirstOrThrow()).toMatchObject({ storageKey: 'milestones/m1/b.zip', url: null });
  });

  it('reports a file missing from the public bucket and leaves its row alone', async () => {
    const scenario = await makeContractScenario();
    await makeMessage(scenario.conversation.id, scenario.client.id, { attachments: [{ url: `${PUBLIC}/messages/c1/gone.pdf` }] });

    const result = await migrateLegacyAttachments({ apply: true });

    expect(result.migrated).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(await prisma.messageAttachment.findFirstOrThrow()).toMatchObject({ storageKey: null, url: `${PUBLIC}/messages/c1/gone.pdf` });
  });
});
