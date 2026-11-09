import { describe, expect, it, vi } from 'vitest';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { jobsOf, runJobs } from './helpers/jobs';
import { makeContractScenario, makeMilestone, makePayment } from './helpers/factories';
import { enqueueJob } from '../src/jobs/queue';
import { markFunded } from '../src/services/milestones.service';
import { HOUR_MS } from '../src/lib/time';

/**
 * Automatic approval and the scheduled milestone notices (auto-approval reminder, due soon,
 * overdue). Time is driven with `runDueJobs({ now })`; nothing sleeps.
 */

const MS = 1;

/** An ACTIVE contract whose milestone was submitted through the API (round 1). */
async function submittedViaApi(opts: { extraMilestone?: boolean } = {}) {
  const scenario = await makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    milestone: { status: 'FUNDED', fundedAt: new Date(), amount: opts.extraMilestone ? 3_000_000 : 4_000_000 },
  });
  await makePayment(scenario.milestone.id, scenario.client.id, { status: 'COMPLETED' });
  const extra = opts.extraMilestone ? await makeMilestone(scenario.contract.id, { amount: 1_000_000 }) : null;
  const res = await authed(scenario.freelancer)
    .post(`/api/milestones/${scenario.milestone.id}/submissions`)
    .send({ message: '산출물' });
  expect(res.status).toBe(201);
  const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: scenario.milestone.id } });
  return { ...scenario, extra, autoApproveAt: stored.autoApproveAt! };
}

const statusOf = async (id: string) => (await prisma.milestone.findUniqueOrThrow({ where: { id } })).status;

describe('milestone.autoApprove job', () => {
  it('does nothing before autoApproveAt, then approves automatically at it', async () => {
    const { milestone, autoApproveAt } = await submittedViaApi({ extraMilestone: true });

    await runJobs(new Date(autoApproveAt.getTime() - MS));
    expect(await statusOf(milestone.id)).toBe('SUBMITTED');

    await runJobs(autoApproveAt);
    const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(stored).toMatchObject({ status: 'APPROVED', approvalType: 'AUTO', autoApproveAt: null });
    expect(stored.approvedAt!.getTime()).toBe(autoApproveAt.getTime());

    const submission = await prisma.milestoneSubmission.findFirstOrThrow();
    expect(submission).toMatchObject({ decision: 'APPROVED', decidedById: null, autoDecided: true });
    expect(await prisma.settlementItem.count()).toBe(1);
    const [job] = await jobsOf('milestone.autoApprove');
    expect(job.status).toBe('SUCCEEDED');
  });

  it('notifies both parties with MILESTONE_AUTO_APPROVED, not MILESTONE_APPROVED', async () => {
    const { client, freelancer, autoApproveAt } = await submittedViaApi({ extraMilestone: true });

    await runJobs(autoApproveAt);

    const auto = await prisma.notification.findMany({ where: { type: 'MILESTONE_AUTO_APPROVED' } });
    expect(auto.map((n) => n.userId).sort()).toEqual([client.id, freelancer.id].sort());
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_APPROVED' } })).toBe(0);
  });

  it('completes the contract when it approves the last milestone', async () => {
    const { contract, project, autoApproveAt } = await submittedViaApi();

    await runJobs(autoApproveAt);

    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.completedAt!.getTime()).toBe(autoApproveAt.getTime());
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('COMPLETED');
    expect(await prisma.notification.count({ where: { type: 'CONTRACT_COMPLETED' } })).toBe(2);
  });

  it('is a no-op after a manual approval', async () => {
    const { client, milestone, autoApproveAt } = await submittedViaApi({ extraMilestone: true });
    await authed(client).post(`/api/milestones/${milestone.id}/approve`);

    await runJobs(autoApproveAt);

    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).approvalType).toBe('MANUAL');
    expect(await prisma.settlementItem.count()).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_AUTO_APPROVED' } })).toBe(0);
    const [job] = await jobsOf('milestone.autoApprove');
    expect(job.status).toBe('SUCCEEDED');
  });

  it('a rejection cancels the timer; the round-1 job never approves round 2 early', async () => {
    const { client, freelancer, milestone, autoApproveAt } = await submittedViaApi({ extraMilestone: true });
    await authed(client).post(`/api/milestones/${milestone.id}/reject`).send({ reason: '다시 확인해 주세요 부탁드립니다' });

    await runJobs(autoApproveAt);
    expect(await statusOf(milestone.id)).toBe('REVISION_REQUESTED');

    // Resubmit; even running the stale round-1 job again afterwards must not approve round 2.
    const res = await authed(freelancer).post(`/api/milestones/${milestone.id}/submissions`).send({ message: '수정본' });
    expect(res.body.submission.round).toBe(2);
    const round2 = (await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).autoApproveAt!;
    await prisma.job.updateMany({ where: { dedupeKey: `milestone.autoApprove:${milestone.id}:1` }, data: { status: 'PENDING', runAt: autoApproveAt } });
    await runJobs(new Date(round2.getTime() - MS));
    expect(await statusOf(milestone.id)).toBe('SUBMITTED');

    await runJobs(round2);
    expect(await statusOf(milestone.id)).toBe('APPROVED');
  });

  it('proceeds on a soft-deleted project: contract completes, project row untouched, no notifications', async () => {
    const { contract, project, autoApproveAt } = await submittedViaApi();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    const before = await prisma.notification.count();

    await runJobs(autoApproveAt);

    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('COMPLETED');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('CLOSED');
    expect(await prisma.settlementItem.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(before);
  });

  it('proceeds when the client is soft-deleted, notifying only the freelancer', async () => {
    const { client, freelancer, autoApproveAt } = await submittedViaApi({ extraMilestone: true });
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });

    await runJobs(autoApproveAt);

    const auto = await prisma.notification.findMany({ where: { type: 'MILESTONE_AUTO_APPROVED' } });
    expect(auto.map((n) => n.userId)).toEqual([freelancer.id]);
  });

  it('manual and automatic approval racing: exactly one wins, one item, one approval notice', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const { client, milestone, autoApproveAt } = await submittedViaApi({ extraMilestone: true });
      // The job may run "now" if autoApproveAt has passed; make it due.
      await prisma.milestone.update({ where: { id: milestone.id }, data: { autoApproveAt: new Date(Date.now() - HOUR_MS) } });
      await prisma.job.updateMany({ where: { type: 'milestone.autoApprove' }, data: { runAt: new Date(Date.now() - HOUR_MS) } });
      expect(autoApproveAt).toBeInstanceOf(Date);

      const [manual] = await Promise.all([
        authed(client).post(`/api/milestones/${milestone.id}/approve`),
        runJobs(new Date()),
      ]);

      expect([200, 409], `iteration ${iteration}`).toContain(manual.status);
      expect(await prisma.settlementItem.count({ where: { milestoneId: milestone.id } })).toBe(1);
      const notices = await prisma.notification.findMany({
        where: { type: { in: ['MILESTONE_APPROVED', 'MILESTONE_AUTO_APPROVED'] }, href: { contains: milestone.id } },
      });
      const kinds = new Set(notices.map((n) => n.type));
      expect(kinds.size, `iteration ${iteration}`).toBe(1);
      const stored = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(stored.approvalType).toBe(manual.status === 200 ? 'MANUAL' : 'AUTO');
    }
  });

  it('fails permanently when the payload names a milestone that does not exist', async () => {
    await prisma.$transaction((tx) => enqueueJob(tx, {
      type: 'milestone.autoApprove',
      payload: { milestoneId: 'no-such-milestone', round: 1 },
      runAt: new Date(Date.now() - 1000),
    }));
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runJobs(new Date());
      expect(result.failed).toBe(1);
    } finally {
      logs.mockRestore();
    }
    const [job] = await jobsOf('milestone.autoApprove');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
  });
});

describe('milestone.autoApproveReminder job', () => {
  it('reminds the client 48 hours before auto-approval', async () => {
    const { client, contract, milestone, autoApproveAt } = await submittedViaApi();
    const remindAt = new Date(autoApproveAt.getTime() - 48 * HOUR_MS);

    await runJobs(new Date(remindAt.getTime() - MS));
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_AUTO_APPROVE_REMINDER' } })).toBe(0);

    await runJobs(remindAt);
    const reminders = await prisma.notification.findMany({ where: { type: 'MILESTONE_AUTO_APPROVE_REMINDER' } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      userId: client.id,
      href: `/contracts/${contract.id}/milestones/${milestone.id}`,
    });
  });

  it('is a no-op once the milestone was decided, or on a soft-deleted project', async () => {
    const decided = await submittedViaApi({ extraMilestone: true });
    await authed(decided.client).post(`/api/milestones/${decided.milestone.id}/approve`);
    const deleted = await submittedViaApi();
    await prisma.project.update({ where: { id: deleted.project.id }, data: { deletedAt: new Date() } });

    await runJobs(new Date(deleted.autoApproveAt.getTime() - 48 * HOUR_MS));

    expect(await prisma.notification.count({ where: { type: 'MILESTONE_AUTO_APPROVE_REMINDER' } })).toBe(0);
  });
});

describe('milestone.dueSoon and milestone.overdue jobs', () => {
  /** An ACTIVE contract with a milestone due in 5 days, funded through the service, which schedules its due-date jobs. */
  async function fundedWithJobs() {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { dueDate: new Date(Date.now() + 5 * 24 * HOUR_MS) },
    });
    const { funded } = await prisma.$transaction((tx) => markFunded(tx, scenario.milestone.id, new Date()));
    expect(funded).toBe(true);
    const milestone = await prisma.milestone.findUniqueOrThrow({ where: { id: scenario.milestone.id } });
    return { ...scenario, milestone };
  }

  it('tells the freelancer 24 hours before the due date, and both parties at it', async () => {
    const { client, freelancer, milestone } = await fundedWithJobs();
    const due = milestone.dueDate.getTime();

    await runJobs(new Date(due - 24 * HOUR_MS - MS));
    expect(await prisma.notification.count({ where: { type: { in: ['MILESTONE_DUE_SOON', 'MILESTONE_OVERDUE'] } } })).toBe(0);

    await runJobs(new Date(due - 24 * HOUR_MS));
    const soon = await prisma.notification.findMany({ where: { type: 'MILESTONE_DUE_SOON' } });
    expect(soon.map((n) => n.userId)).toEqual([freelancer.id]);

    await runJobs(new Date(due));
    const overdue = await prisma.notification.findMany({ where: { type: 'MILESTONE_OVERDUE' } });
    expect(overdue.map((n) => n.userId).sort()).toEqual([client.id, freelancer.id].sort());
  });

  it('stays quiet once the work is submitted', async () => {
    const { milestone } = await fundedWithJobs();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });

    await runJobs(milestone.dueDate);

    expect(await prisma.notification.count({ where: { type: { in: ['MILESTONE_DUE_SOON', 'MILESTONE_OVERDUE'] } } })).toBe(0);
  });

  it('still notifies while REVISION_REQUESTED', async () => {
    const { milestone } = await fundedWithJobs();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'REVISION_REQUESTED' } });

    await runJobs(milestone.dueDate);

    expect(await prisma.notification.count({ where: { type: 'MILESTONE_OVERDUE' } })).toBe(2);
  });

  it('is a no-op on a soft-deleted project', async () => {
    const { project, milestone } = await fundedWithJobs();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    await runJobs(milestone.dueDate);

    expect(await prisma.notification.count({ where: { type: { in: ['MILESTONE_DUE_SOON', 'MILESTONE_OVERDUE'] } } })).toBe(0);
  });
});
