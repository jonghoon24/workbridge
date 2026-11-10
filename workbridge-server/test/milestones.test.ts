import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No test may reach Supabase; submission files go through this in-memory storage.
vi.mock('@supabase/supabase-js', async () => {
  const { storage } = await import('./helpers/storageFake.js');
  return { createClient: () => storage.client };
});

import { api, authed } from './helpers/api';
import { storage } from './helpers/storageFake';
import { ATTACHMENT_BUCKET, pdf, png, uploadFiles } from './helpers/attachments';
import { prisma } from './helpers/db';
import { makeContractScenario, makeMilestone, makePayment, makeSubmission } from './helpers/factories';
import { DAY_MS, HOUR_MS } from '../src/lib/time';

/**
 * Milestone detail, submission, approval and rejection, and the payout preview. The
 * 401/403/ownership matrix is in authorization.test.ts; automatic approval in auto-approval.test.ts.
 */

beforeEach(() => {
  storage.reset();
});

afterEach(() => {
  delete process.env.MILESTONE_AUTO_APPROVE_DAYS;
});

/** An ACTIVE contract whose single milestone is FUNDED (amount 4,000,000). */
async function funded() {
  const scenario = await makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    milestone: { status: 'FUNDED', fundedAt: new Date() },
  });
  await makePayment(scenario.milestone.id, scenario.client.id, { status: 'COMPLETED' });
  return scenario;
}

/** As `funded`, with the milestone SUBMITTED (round 1, auto-approval due in 7 days). */
async function submitted(overrides: { milestones?: number } = {}) {
  const scenario = await funded();
  const now = Date.now();
  await prisma.milestone.update({
    where: { id: scenario.milestone.id },
    data: { status: 'SUBMITTED', submittedAt: new Date(now), autoApproveAt: new Date(now + 7 * DAY_MS) },
  });
  const submission = await makeSubmission(scenario.milestone.id);
  const extra = [];
  for (let i = 1; i < (overrides.milestones ?? 1); i += 1) {
    extra.push(await makeMilestone(scenario.contract.id, { amount: 1_000_000 }));
  }
  return { ...scenario, submission, extra };
}

const submit = (user: Parameters<typeof authed>[0], milestoneId: string) =>
  authed(user).post(`/api/milestones/${milestoneId}/submissions`);

// ---------------------------------------------------------------------------------------------
// GET /api/milestones/:id
// ---------------------------------------------------------------------------------------------

describe('GET /api/milestones/:id', () => {
  it('returns the milestone with every submission newest first, its payment and contract summary', async () => {
    const { client, freelancer, project, contract, milestone } = await submitted();
    await prisma.milestoneSubmission.updateMany({ where: { milestoneId: milestone.id }, data: { decision: 'REJECTED', decisionReason: 'Fix the header please' } });
    const second = await makeSubmission(milestone.id, { round: 2 });
    await prisma.milestoneAttachment.create({
      data: { submissionId: second.id, url: 'https://x/y.pdf', fileName: '보고서.pdf', mimeType: 'application/pdf', size: 3 },
    });

    const asFreelancer = await authed(freelancer).get(`/api/milestones/${milestone.id}`);
    const asClient = await authed(client).get(`/api/milestones/${milestone.id}`);

    expect(asFreelancer.status).toBe(200);
    expect(asClient.body).toEqual(asFreelancer.body);
    expect(asClient.body).toMatchObject({
      id: milestone.id,
      status: 'SUBMITTED',
      payment: { status: 'COMPLETED' },
      latestSubmission: { id: second.id, round: 2 },
      payoutPreview: { gross: 4_000_000, fee: 400_000, vat: 40_000, net: 3_560_000 },
      contract: {
        id: contract.id,
        status: 'ACTIVE',
        amount: 4_000_000,
        clientId: client.id,
        freelancerId: freelancer.id,
        project: { id: project.id, title: project.title },
      },
    });
    // The Toss payment key goes to no one: both parties read this milestone.
    expect(asClient.body.payment).not.toHaveProperty('paymentKey');
    expect(asClient.body.submissions.map((s: { round: number }) => s.round)).toEqual([2, 1]);
    expect(asClient.body.submissions[0].attachments).toMatchObject([{ fileName: '보고서.pdf', size: 3 }]);
    // Exactly these keys — no submissionId.
    expect(Object.keys(asClient.body.submissions[0].attachments[0]).sort())
      .toEqual(['createdAt', 'fileName', 'id', 'mimeType', 'size', 'url']);
    expect(Object.keys(asClient.body.submissions[0]).sort()).toEqual([
      'attachments', 'autoDecided', 'decidedAt', 'decidedById', 'decision', 'decisionReason',
      'id', 'links', 'message', 'milestoneId', 'round', 'submittedAt',
    ]);
    expect(asClient.body.submissions[1]).toMatchObject({ decision: 'REJECTED', decisionReason: 'Fix the header please' });
  });

  it("previews from the settlement item's stored values once approved", async () => {
    const { client, freelancer, contract, milestone } = await submitted();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'APPROVED' } });
    await prisma.settlementItem.create({
      data: {
        milestoneId: milestone.id,
        contractId: contract.id,
        freelancerId: freelancer.id,
        grossAmount: 4_000_000,
        feeRateBps: 500,
        feeAmount: 200_000,
        feeVatAmount: 20_000,
        netAmount: 3_780_000,
        approvedAt: new Date(),
      },
    });

    const res = await authed(client).get(`/api/milestones/${milestone.id}`);

    expect(res.body.payoutPreview).toEqual({ gross: 4_000_000, fee: 200_000, vat: 20_000, net: 3_780_000 });
  });

  it('falls back to the current fee rate (10% fee, 10% VAT on the fee) for an approval with no settlement item (backfill)', async () => {
    const { client, milestone } = await makeContractScenario({ contract: { status: 'COMPLETED' } });
    expect(milestone.status).toBe('APPROVED');

    const res = await authed(client).get(`/api/milestones/${milestone.id}`);

    expect(res.body.payoutPreview).toEqual({ gross: 4_000_000, fee: 400_000, vat: 40_000, net: 3_560_000 });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/milestones/:id/submissions
// ---------------------------------------------------------------------------------------------

describe('POST /api/milestones/:id/submissions', () => {
  it('submits a FUNDED milestone: round 1, SUBMITTED, 7-day timer, two jobs, client notified', async () => {
    const { client, freelancer, contract, milestone } = await funded();
    const before = Date.now();

    const res = await submit(freelancer, milestone.id).send({ message: '  1차 산출물입니다  ', links: ['https://figma.com/x'] });
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['milestone', 'submission']);
    expect(res.body.submission).toMatchObject({
      milestoneId: milestone.id,
      round: 1,
      message: '1차 산출물입니다',
      links: ['https://figma.com/x'],
      decision: null,
      attachments: [],
    });
    expect(res.body.milestone).toMatchObject({ status: 'SUBMITTED', latestSubmission: { round: 1 } });

    const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    const autoApproveAt = stored.autoApproveAt!.getTime();
    expect(autoApproveAt - stored.submittedAt!.getTime()).toBe(7 * DAY_MS);
    expect(stored.submittedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.submittedAt!.getTime()).toBeLessThanOrEqual(after);

    // The client's MILESTONE_SUBMITTED email job is asserted in email.test.ts.
    const jobs = await prisma.job.findMany({ where: { type: { not: 'notification.email' } }, orderBy: { runAt: 'asc' } });
    expect(jobs.map((j) => [j.type, j.dedupeKey, j.payload])).toEqual([
      ['milestone.autoApproveReminder', `milestone.autoApproveReminder:${milestone.id}:1`, { milestoneId: milestone.id, round: 1 }],
      ['milestone.autoApprove', `milestone.autoApprove:${milestone.id}:1`, { milestoneId: milestone.id, round: 1 }],
    ]);
    expect(jobs[0].runAt.getTime()).toBe(autoApproveAt - 48 * HOUR_MS);
    expect(jobs[1].runAt.getTime()).toBe(autoApproveAt);

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: client.id,
      type: 'MILESTONE_SUBMITTED',
      href: `/contracts/${contract.id}/milestones/${milestone.id}`,
    });
  });

  it('attaches files uploaded under milestones/<id>/, in upload order, with signed URLs', async () => {
    const { freelancer, milestone } = await funded();
    const { ids, keys } = await uploadFiles(storage, freelancer, `/api/milestones/${milestone.id}`, [
      pdf('최종 보고서.pdf', 8),
      png('shot.png', 3),
    ]);

    const res = await submit(freelancer, milestone.id).send({ message: '파일 첨부', links: 'https://example.com/a', uploadIds: ids });

    expect(res.status).toBe(201);
    expect(res.body.submission.links).toEqual(['https://example.com/a']);
    const attachments = res.body.submission.attachments;
    expect(attachments.map((a: { fileName: string }) => a.fileName)).toEqual(['최종 보고서.pdf', 'shot.png']);
    expect(attachments[0]).toMatchObject({ mimeType: 'application/pdf', size: 8 });
    for (const key of keys) expect(key).toMatch(new RegExp(`^milestones/${milestone.id}/[0-9a-f-]{36}\\.(pdf|png)$`));
    expect(attachments.map((a: { url: string }) => a.url)).toEqual(
      keys.map((key) => expect.stringContaining(`/object/sign/${ATTACHMENT_BUCKET}/${key}?`)),
    );
    expect(res.body.milestone.latestSubmission.attachments.map((a: { id: string }) => a.id))
      .toEqual(attachments.map((a: { id: string }) => a.id));
    expect(await prisma.milestoneAttachment.count({ where: { url: null } })).toBe(2);
    expect(await prisma.attachmentUpload.count()).toBe(0);
  });

  it('a storage failure while checking the uploads is a 502 and writes nothing', async () => {
    const { freelancer, milestone } = await funded();
    const { ids } = await uploadFiles(storage, freelancer, `/api/milestones/${milestone.id}`, [pdf()]);
    storage.bucket(ATTACHMENT_BUCKET).info.mockResolvedValueOnce(
      { data: null, error: Object.assign(new Error('bucket down'), { status: 503, statusCode: '503' }) } as never,
    );

    const res = await submit(freelancer, milestone.id).send({ message: 'x', uploadIds: ids });

    expect(res.status).toBe(502);
    expect(await prisma.milestoneSubmission.count()).toBe(0);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).status).toBe('FUNDED');
  });

  it('resubmits after a rejection as round 2 with fresh round-2 jobs', async () => {
    const { freelancer, milestone } = await submitted();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'REVISION_REQUESTED', autoApproveAt: null } });

    const res = await submit(freelancer, milestone.id).send({ message: '수정본' });

    expect(res.status).toBe(201);
    expect(res.body.submission.round).toBe(2);
    const keys = (await prisma.job.findMany({ where: { type: { not: 'notification.email' } } })).map((j) => j.dedupeKey).sort();
    expect(keys).toEqual([
      `milestone.autoApprove:${milestone.id}:2`,
      `milestone.autoApproveReminder:${milestone.id}:2`,
    ]);
  });

  it.each(['PENDING', 'SUBMITTED', 'APPROVED'] as const)('409s for a %s milestone, before touching storage', async (status) => {
    const { freelancer, milestone } = await funded();
    const { ids } = await uploadFiles(storage, freelancer, `/api/milestones/${milestone.id}`, [pdf()]);
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status } });

    const res = await submit(freelancer, milestone.id).send({ message: 'x', uploadIds: ids });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Milestone is not awaiting a submission' } });
    expect(await prisma.milestoneSubmission.count()).toBe(0);
    expect(storage.bucket(ATTACHMENT_BUCKET).info).not.toHaveBeenCalled();
    expect(await prisma.attachmentUpload.count()).toBe(1);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a missing message', {}, 'message: Message is required'],
    ['a blank message', { message: '   ' }, 'message: Message is required'],
    ['a 5001-character message', { message: 'x'.repeat(5001) }, 'message: Message must be at most 5000 characters'],
    ['six links', { message: 'x', links: Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`) }, 'links: At most 5 links are allowed'],
    ['a non-http link', { message: 'x', links: ['ftp://e.com/file'] }, 'links.0: Links must be http or https URLs'],
    ['a relative link', { message: 'x', links: ['/just/a/path'] }, 'links.0: Links must be http or https URLs'],
    ['a 2001-character link', { message: 'x', links: [`https://e.com/${'a'.repeat(1990)}`] }, 'links.0: Links must be http or https URLs'],
  ])('400s on %s with an exact message', async (_label, body, message) => {
    const { freelancer, milestone } = await funded();

    const res = await submit(freelancer, milestone.id).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
  });

  it('accepts exactly 5000 characters and exactly 5 links, and a single link as a string', async () => {
    const { freelancer, milestone } = await funded();

    const res = await submit(freelancer, milestone.id).send({
      message: 'x'.repeat(5000),
      links: Array.from({ length: 5 }, (_, i) => `http://e.com/${i}`),
    });

    expect(res.status).toBe(201);
    expect(res.body.submission.links).toHaveLength(5);
  });

  it('validates before looking the milestone up: a bad body on a missing id is 400', async () => {
    const { freelancer } = await funded();

    const res = await submit(freelancer, 'missing-milestone-id').send({ message: '' });

    expect(res.status).toBe(400);
  });

  it('two concurrent submissions: one 201, one 409, one submission, never a 500', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const { freelancer, milestone } = await funded();
      await Promise.all([1, 2, 3].map(() => authed(freelancer).get(`/api/milestones/${milestone.id}`)));

      const responses = await Promise.all([
        submit(freelancer, milestone.id).send({ message: 'a' }),
        submit(freelancer, milestone.id).send({ message: 'b' }),
      ]);

      expect(responses.map((r) => r.status).sort(), `iteration ${iteration}`).toEqual([201, 409]);
      expect(await prisma.milestoneSubmission.count({ where: { milestoneId: milestone.id } })).toBe(1);
    }
  });

  it('honors MILESTONE_AUTO_APPROVE_DAYS, and skips the reminder when it would not be in the future', async () => {
    process.env.MILESTONE_AUTO_APPROVE_DAYS = '2';
    const { freelancer, milestone } = await funded();

    await submit(freelancer, milestone.id).send({ message: 'x' });

    const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(stored.autoApproveAt!.getTime() - stored.submittedAt!.getTime()).toBe(2 * DAY_MS);
    expect((await prisma.job.findMany({ where: { type: { not: 'notification.email' } } })).map((j) => j.type)).toEqual(['milestone.autoApprove']);
  });

  it.each(['0', '-3', '1.5', 'seven'])('falls back to 7 days for MILESTONE_AUTO_APPROVE_DAYS=%s', async (value) => {
    process.env.MILESTONE_AUTO_APPROVE_DAYS = value;
    const { freelancer, milestone } = await funded();

    await submit(freelancer, milestone.id).send({ message: 'x' });

    const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(stored.autoApproveAt!.getTime() - stored.submittedAt!.getTime()).toBe(7 * DAY_MS);
  });

  it('accepts a submission after the due date (no late penalty)', async () => {
    const { freelancer, milestone } = await funded();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { dueDate: new Date(Date.now() - DAY_MS) } });

    expect((await submit(freelancer, milestone.id).send({ message: 'late' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/milestones/:id/approve
// ---------------------------------------------------------------------------------------------

describe('POST /api/milestones/:id/approve', () => {
  it('approves: APPROVED/MANUAL, submission decided, settlement item, freelancer notified', async () => {
    const { client, freelancer, contract, milestone, submission } = await submitted({ milestones: 2 });

    const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['contract', 'milestone']);
    expect(res.body.milestone).toMatchObject({ status: 'APPROVED', approvalType: 'MANUAL', autoApproveAt: null });
    expect(res.body.contract).toEqual({ id: contract.id, status: 'ACTIVE', completedAt: null });

    const decided = await prisma.milestoneSubmission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(decided).toMatchObject({ decision: 'APPROVED', decidedById: client.id, autoDecided: false });
    expect(decided.decidedAt).not.toBeNull();

    const items = await prisma.settlementItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      milestoneId: milestone.id,
      contractId: contract.id,
      freelancerId: freelancer.id,
      settlementId: null,
      grossAmount: 4_000_000,
      feeRateBps: 1000,
      feeAmount: 400_000,
      feeVatAmount: 40_000,
      netAmount: 3_560_000,
    });
    const approved = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(items[0].approvedAt.getTime()).toBe(approved.approvedAt!.getTime());

    const notifications = await prisma.notification.findMany();
    expect(notifications.map((n) => [n.type, n.userId])).toEqual([['MILESTONE_APPROVED', freelancer.id]]);
  });

  it('completes the contract and project when the last milestone is approved', async () => {
    const { client, freelancer, project, contract, milestone } = await submitted();

    const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(res.status).toBe(200);
    expect(res.body.contract).toMatchObject({ id: contract.id, status: 'COMPLETED' });
    expect(res.body.contract.completedAt).not.toBeNull();
    const storedContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(storedContract.status).toBe('COMPLETED');
    // Directly from CLOSED, bypassing validTransitions.
    expect(project.status).toBe('CLOSED');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('COMPLETED');

    const completed = await prisma.notification.findMany({ where: { type: 'CONTRACT_COMPLETED' } });
    expect(completed.map((n) => n.userId).sort()).toEqual([client.id, freelancer.id].sort());
    for (const n of completed) expect(n.href).toBe(`/contracts/${contract.id}#review`);

    // Reviews become possible.
    const review = await authed(client).post('/api/reviews').send({
      contractId: contract.id, revieweeId: freelancer.id, rating: 5, content: '좋았습니다',
    });
    expect(review.status).toBe(201);
  });

  it.each(['FUNDED', 'REVISION_REQUESTED', 'APPROVED'] as const)('409s for a %s milestone and writes nothing', async (status) => {
    const { client, milestone } = await submitted();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status } });

    const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Milestone is not awaiting review' } });
    expect(await prisma.settlementItem.count()).toBe(0);
  });

  it('approves even when the freelancer is soft-deleted, skipping only their notification', async () => {
    const { client, freelancer, milestone } = await submitted({ milestones: 2 });
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(res.status).toBe(200);
    expect(await prisma.settlementItem.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('is atomic: a failing settlement-item insert leaves the milestone SUBMITTED', async () => {
    const { client, milestone } = await submitted();
    await prisma.$executeRawUnsafe(`ALTER TABLE "SettlementItem" ADD CONSTRAINT "tmp_no_items" CHECK (false) NOT VALID`);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

      expect(res.status).toBe(500);
      const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(stored.status).toBe('SUBMITTED');
      expect((await prisma.milestoneSubmission.findFirstOrThrow()).decision).toBeNull();
      expect(await prisma.notification.count()).toBe(0);
    } finally {
      logs.mockRestore();
      await prisma.$executeRawUnsafe(`ALTER TABLE "SettlementItem" DROP CONSTRAINT "tmp_no_items"`);
    }
  });

  /**
   * Approving the last two milestones at the same time must complete the contract. Each
   * approval locks the contract row first, so the second sees the first in its completion count.
   */
  it('two concurrent approvals of the last two milestones complete the contract exactly once', async () => {
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const { client, freelancer, contract, milestone } = await submitted();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { amount: 3_000_000 } });
      const other = await makeMilestone(contract.id, { amount: 1_000_000, status: 'SUBMITTED' });
      await makeSubmission(other.id);
      await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));

      const responses = await Promise.all([
        authed(client).post(`/api/milestones/${milestone.id}/approve`),
        authed(client).post(`/api/milestones/${other.id}/approve`),
      ]);

      expect(responses.map((r) => r.status), `iteration ${iteration}`).toEqual([200, 200]);
      const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
      expect(stored.status, `iteration ${iteration}`).toBe('COMPLETED');
      const completed = await prisma.notification.findMany({
        where: { type: 'CONTRACT_COMPLETED', href: `/contracts/${contract.id}#review` },
      });
      expect(completed.map((n) => n.userId).sort()).toEqual([client.id, freelancer.id].sort());
    }
  });

  it('two concurrent approvals of one milestone: one 200, one 409, one settlement item', async () => {
    const { client, milestone } = await submitted();
    await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));

    const responses = await Promise.all([
      authed(client).post(`/api/milestones/${milestone.id}/approve`),
      authed(client).post(`/api/milestones/${milestone.id}/approve`),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.settlementItem.count()).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_APPROVED' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/milestones/:id/reject
// ---------------------------------------------------------------------------------------------

describe('POST /api/milestones/:id/reject', () => {
  const REASON = '헤더 레이아웃을 시안대로 맞춰주세요';

  it('sends the submission back: REVISION_REQUESTED, count +1, timer cleared, freelancer notified', async () => {
    const { client, freelancer, milestone, submission } = await submitted();

    const res = await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: `  ${REASON}  ` });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['milestone']);
    expect(res.body.milestone).toMatchObject({
      status: 'REVISION_REQUESTED',
      revisionCount: 1,
      autoApproveAt: null,
      latestSubmission: { id: submission.id, decision: 'REJECTED', decisionReason: REASON, decidedById: client.id },
    });
    const notifications = await prisma.notification.findMany();
    expect(notifications.map((n) => [n.type, n.userId])).toEqual([['MILESTONE_REVISION_REQUESTED', freelancer.id]]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a missing reason', {}, 'reason: Reason must be at least 10 characters'],
    ['a 9-character reason', { reason: '123456789' }, 'reason: Reason must be at least 10 characters'],
    ['a reason that is short once trimmed', { reason: '   12345678   ' }, 'reason: Reason must be at least 10 characters'],
    ['a 2001-character reason', { reason: 'x'.repeat(2001) }, 'reason: Reason must be at most 2000 characters'],
  ])('400s on %s', async (_label, body, message) => {
    const { client, milestone } = await submitted();

    const res = await authed(client).post(`/api/milestones/${milestone.id}/reject`).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).status).toBe('SUBMITTED');
  });

  it('accepts exactly 10 and exactly 2000 characters', async () => {
    const first = await submitted();
    expect((await authed(first.client).post(`/api/milestones/${first.milestone.id}/reject`).send({ reason: '1234567890' })).status).toBe(200);
    const second = await submitted();
    expect((await authed(second.client).post(`/api/milestones/${second.milestone.id}/reject`).send({ reason: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('409s unless SUBMITTED', async () => {
    const { client, milestone } = await funded();

    const res = await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: REASON });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Milestone is not awaiting review' } });
  });

  it('has no cap on revisions: reject, resubmit, reject again, then approve', async () => {
    const { client, freelancer, milestone } = await submitted({ milestones: 2 });

    for (let round = 2; round <= 3; round += 1) {
      expect((await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: REASON })).status).toBe(200);
      const res = await submit(freelancer, milestone.id).send({ message: `round ${round}` });
      expect(res.body.submission.round).toBe(round);
    }
    const approved = await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(approved.status).toBe(200);
    expect(approved.body.milestone).toMatchObject({ revisionCount: 2, latestSubmission: { round: 3, decision: 'APPROVED' } });
  });
});

describe('unauthenticated access', () => {
  it('every milestone route requires a token', async () => {
    const res = await api().get('/api/milestones/x');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------------------------

describe('system messages of submission, review and completion', () => {
  /** The conversation's system events, oldest first; every one without a sender. */
  async function systemMessages(conversationId: string) {
    const messages = await prisma.message.findMany({
      where: { conversationId, kind: 'SYSTEM' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const m of messages) expect(m.senderId).toBeNull();
    return messages.map((m) => m.systemEvent);
  }

  it('a submission posts MILESTONE_SUBMITTED; a refused one posts nothing', async () => {
    const { freelancer, milestone, conversation } = await funded();

    expect((await submit(freelancer, milestone.id).send({ message: '1차' })).status).toBe(201);
    expect((await submit(freelancer, milestone.id).send({ message: '중복' })).status).toBe(409);

    expect(await systemMessages(conversation.id)).toEqual(['MILESTONE_SUBMITTED']);
  });

  it('a rejection posts MILESTONE_REVISION_REQUESTED', async () => {
    const { client, milestone, conversation } = await submitted();

    const res = await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: '헤더 레이아웃을 고쳐주세요.' });

    expect(res.status).toBe(200);
    expect(await systemMessages(conversation.id)).toEqual(['MILESTONE_REVISION_REQUESTED']);
  });

  it('approving a milestone that is not the last posts MILESTONE_APPROVED only', async () => {
    const { client, milestone, conversation } = await submitted({ milestones: 2 });

    await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(await systemMessages(conversation.id)).toEqual(['MILESTONE_APPROVED']);
  });

  it('approving the last milestone posts MILESTONE_APPROVED, then CONTRACT_COMPLETED', async () => {
    const { client, milestone, conversation } = await submitted();

    await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    expect(await systemMessages(conversation.id)).toEqual(['MILESTONE_APPROVED', 'CONTRACT_COMPLETED']);
    const [approved, completed] = await prisma.message.findMany({ orderBy: { createdAt: 'asc' } });
    expect(completed.createdAt.getTime()).toBeGreaterThan(approved.createdAt.getTime());
    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.lastMessageAt?.getTime()).toBe(completed.createdAt.getTime());
  });

  it('a rolled-back approval posts nothing', async () => {
    const { client, milestone, conversation } = await submitted();
    await prisma.$executeRawUnsafe(`ALTER TABLE "SettlementItem" ADD CONSTRAINT "tmp_no_items" CHECK (false) NOT VALID`);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await authed(client).post(`/api/milestones/${milestone.id}/approve`)).status).toBe(500);
      expect(await systemMessages(conversation.id)).toEqual([]);
    } finally {
      logs.mockRestore();
      await prisma.$executeRawUnsafe(`ALTER TABLE "SettlementItem" DROP CONSTRAINT "tmp_no_items"`);
    }
  });

  it('two concurrent approvals of one milestone post one MILESTONE_APPROVED', async () => {
    const { client, milestone, conversation } = await submitted({ milestones: 2 });
    await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));

    await Promise.all([
      authed(client).post(`/api/milestones/${milestone.id}/approve`),
      authed(client).post(`/api/milestones/${milestone.id}/approve`),
    ]);

    expect(await systemMessages(conversation.id)).toEqual(['MILESTONE_APPROVED']);
  });

  it('concurrent approvals of the last two milestones: two approvals, then one completion', async () => {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const { client, contract, milestone, conversation } = await submitted();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { amount: 3_000_000 } });
      const other = await makeMilestone(contract.id, { amount: 1_000_000, status: 'SUBMITTED' });
      await makeSubmission(other.id);
      await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));

      await Promise.all([
        authed(client).post(`/api/milestones/${milestone.id}/approve`),
        authed(client).post(`/api/milestones/${other.id}/approve`),
      ]);

      expect(await systemMessages(conversation.id), `iteration ${iteration}`)
        .toEqual(['MILESTONE_APPROVED', 'MILESTONE_APPROVED', 'CONTRACT_COMPLETED']);
    }
  });
});
