import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma, sideClient } from './helpers/db';
import { jobsOf, runJobs } from './helpers/jobs';
import { makeClient, makeContractScenario, makeFreelancer, makePayoutAccount } from './helpers/factories';
import { enqueueJob } from '../src/jobs/queue';
import { payoutBreakdown } from '../src/lib/money';
import { setPayoutProvider, LogPayoutProvider } from '../src/lib/payout/provider';
import type { PayoutProvider } from '../src/lib/payout/provider';
import { DAY_MS, HOUR_MS, nextKstWeekday } from '../src/lib/time';
import { runPayout, runWeeklyBatch, weeklyBatchDedupeKey } from '../src/services/settlements.service';

/**
 * Weekly settlements and payouts — the batch and payout jobs, fee arithmetic, the KST weekly
 * calendar and the read endpoints. Product rules: `docs/domain/milestones-payments.md`. Time is
 * driven with `runDueJobs({ now })` at fixed instants.
 */

// A worked calendar example: one KST week, its Monday 03:00 batch and Wednesday 10:00 payout.
const PERIOD_START = new Date('2026-10-18T15:00:00.000Z'); // Mon 2026-10-19 00:00 KST
const PERIOD_END = new Date('2026-10-25T15:00:00.000Z'); // Mon 2026-10-26 00:00 KST
const BATCH_AT = new Date('2026-10-25T18:00:00.000Z'); // Mon 2026-10-26 03:00 KST
const PAYOUT_AT = new Date('2026-10-28T01:00:00.000Z'); // Wed 2026-10-28 10:00 KST
const TUESDAY = new Date('2026-10-20T05:00:00.000Z'); // Tue 2026-10-20 14:00 KST

afterEach(() => {
  setPayoutProvider(new LogPayoutProvider());
  process.env.JOB_PAYOUT_ENABLED = 'true';
});

/** An approved milestone of `freelancer` and its settlement item, as an approval would leave it. */
async function approvedItem(freelancer: User | null, approvedAt: Date, gross = 1_000_000) {
  const scenario = await makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true, ...(freelancer ? { freelancerId: freelancer.id } : {}) },
    milestone: { status: 'APPROVED', approvalType: 'MANUAL', approvedAt, amount: gross },
  });
  const b = payoutBreakdown(gross);
  const item = await prisma.settlementItem.create({
    data: {
      milestoneId: scenario.milestone.id,
      contractId: scenario.contract.id,
      freelancerId: scenario.contract.freelancerId,
      grossAmount: b.gross,
      feeRateBps: 1000,
      feeAmount: b.fee,
      feeVatAmount: b.vat,
      netAmount: b.net,
      approvedAt,
    },
  });
  return { ...scenario, item };
}

async function enqueueBatch(slot: Date = BATCH_AT) {
  await prisma.$transaction((tx) => enqueueJob(tx, {
    type: 'settlement.weeklyBatch',
    runAt: slot,
    dedupeKey: weeklyBatchDedupeKey(slot),
  }));
}

/** A SCHEDULED settlement for `freelancer`, with its payout job, as the batch leaves it. */
async function scheduled(freelancer: User, gross = 1_000_000) {
  await approvedItem(freelancer, TUESDAY, gross);
  await runWeeklyBatch(PERIOD_START, BATCH_AT);
  return prisma.settlement.findFirstOrThrow({ where: { freelancerId: freelancer.id } });
}

function failingProvider(times = Infinity): PayoutProvider {
  let calls = 0;
  return {
    async transfer() {
      calls += 1;
      if (calls <= times) throw new Error(`bank rejected transfer #${calls}`);
      return { reference: `ref-${calls}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Weekly batch
// ---------------------------------------------------------------------------------------------

describe('settlement.weeklyBatch', () => {
  it("settles the slot's week per freelancer: SCHEDULED, item sums, payout Wednesday 10:00 KST", async () => {
    const freelancer = await makeFreelancer();
    await approvedItem(freelancer, TUESDAY, 15_005);
    await approvedItem(freelancer, new Date(PERIOD_END.getTime() - 1), 15_005);
    await enqueueBatch();

    await runJobs(BATCH_AT);

    const settlements = await prisma.settlement.findMany();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      freelancerId: freelancer.id,
      status: 'SCHEDULED',
      itemCount: 2,
      grossAmount: 30_010,
      feeAmount: 3_000,
      feeVatAmount: 300,
      netAmount: 26_710,
      payoutAttempts: 0,
    });
    expect(settlements[0].periodStart.toISOString()).toBe(PERIOD_START.toISOString());
    expect(settlements[0].periodEnd.toISOString()).toBe(PERIOD_END.toISOString());
    expect(settlements[0].scheduledPayoutAt.toISOString()).toBe(PAYOUT_AT.toISOString());
    expect(await prisma.settlementItem.count({ where: { settlementId: settlements[0].id } })).toBe(2);

    const notifications = await prisma.notification.findMany({ where: { type: 'SETTLEMENT_SCHEDULED' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ userId: freelancer.id, href: `/settlements/${settlements[0].id}` });

    const [payout] = await jobsOf('settlement.payout');
    expect(payout).toMatchObject({
      dedupeKey: `settlement.payout:${settlements[0].id}:${PAYOUT_AT.toISOString()}`,
      payload: { settlementId: settlements[0].id, scheduledPayoutAt: PAYOUT_AT.toISOString() },
    });
    expect(payout.runAt.toISOString()).toBe(PAYOUT_AT.toISOString());
  });

  it('leaves out an item approved exactly at periodEnd, and catches up older unsettled items', async () => {
    const freelancer = await makeFreelancer();
    const old = await approvedItem(freelancer, new Date('2026-09-01T00:00:00.000Z'));
    const boundary = await approvedItem(freelancer, PERIOD_END);

    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    const settlement = await prisma.settlement.findFirstOrThrow();
    expect((await prisma.settlementItem.findUniqueOrThrow({ where: { id: old.item.id } })).settlementId).toBe(settlement.id);
    expect((await prisma.settlementItem.findUniqueOrThrow({ where: { id: boundary.item.id } })).settlementId).toBeNull();
  });

  it('creates one settlement per freelancer and none for a freelancer without items', async () => {
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    await makeFreelancer();
    await approvedItem(a, TUESDAY);
    await approvedItem(b, TUESDAY);

    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    expect((await prisma.settlement.findMany()).map((s) => s.freelancerId).sort()).toEqual([a.id, b.id].sort());
  });

  it('a retried batch settles its own week, never the one its new runAt falls in', async () => {
    const freelancer = await makeFreelancer();
    await approvedItem(freelancer, TUESDAY);
    const nextWeek = await approvedItem(freelancer, new Date(PERIOD_END.getTime() + DAY_MS));
    await enqueueBatch();
    // As a retry would leave it: runAt pushed far past the slot.
    const late = new Date(BATCH_AT.getTime() + 9 * DAY_MS);
    await prisma.job.updateMany({ where: { type: 'settlement.weeklyBatch' }, data: { runAt: late } });

    await runJobs(late);

    const settlement = await prisma.settlement.findFirstOrThrow();
    expect(settlement.periodStart.toISOString()).toBe(PERIOD_START.toISOString());
    expect(settlement.itemCount).toBe(1);
    expect((await prisma.settlementItem.findUniqueOrThrow({ where: { id: nextWeek.item.id } })).settlementId).toBeNull();
    // Its payout date is already past, so the payout runs on the next runner pass.
    expect(settlement.scheduledPayoutAt < late).toBe(true);
    await runJobs(late);
    expect((await prisma.settlement.findFirstOrThrow()).status).toBe('ON_HOLD');
  });

  it('is idempotent: a re-run adds new items to a SCHEDULED settlement without a second notice', async () => {
    const freelancer = await makeFreelancer();
    await approvedItem(freelancer, TUESDAY, 1_000_000);
    await runWeeklyBatch(PERIOD_START, BATCH_AT);
    await runWeeklyBatch(PERIOD_START, BATCH_AT);
    expect(await prisma.settlement.count()).toBe(1);

    await approvedItem(freelancer, new Date(PERIOD_END.getTime() - HOUR_MS), 2_000_000);
    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    const settlement = await prisma.settlement.findFirstOrThrow();
    expect(settlement).toMatchObject({ itemCount: 2, grossAmount: 3_000_000, netAmount: 890_000 + 1_780_000 });
    expect(await prisma.notification.count({ where: { type: 'SETTLEMENT_SCHEDULED' } })).toBe(1);
    expect(await prisma.job.count({ where: { type: 'settlement.payout' } })).toBe(1);
  });

  it('leaves new items unsettled when that week’s settlement has moved on', async () => {
    const freelancer = await makeFreelancer();
    const first = await scheduled(freelancer);
    await prisma.settlement.update({ where: { id: first.id }, data: { status: 'PAID' } });
    const late = await approvedItem(freelancer, new Date(PERIOD_END.getTime() - HOUR_MS));

    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    expect((await prisma.settlementItem.findUniqueOrThrow({ where: { id: late.item.id } })).settlementId).toBeNull();
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: first.id } })).itemCount).toBe(1);
  });

  it("isolates one freelancer's failure and retries the job; the retry settles the rest", async () => {
    const ok = await makeFreelancer();
    const broken = await makeFreelancer();
    await approvedItem(ok, TUESDAY);
    await approvedItem(broken, TUESDAY);
    await enqueueBatch();
    await prisma.$executeRawUnsafe(`ALTER TABLE "Settlement" ADD CONSTRAINT "tmp_block" CHECK ("freelancerId" <> '${broken.id}')`);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runJobs(BATCH_AT);
      expect(result.retried).toBe(1);
      expect((await prisma.settlement.findMany()).map((s) => s.freelancerId)).toEqual([ok.id]);
    } finally {
      logs.mockRestore();
      await prisma.$executeRawUnsafe(`ALTER TABLE "Settlement" DROP CONSTRAINT "tmp_block"`);
    }

    const [job] = await jobsOf('settlement.weeklyBatch');
    expect(job.status).toBe('PENDING');
    await runJobs(job.runAt);

    expect((await prisma.settlement.findMany()).map((s) => s.freelancerId).sort()).toEqual([ok.id, broken.id].sort());
    expect(await prisma.notification.count({ where: { type: 'SETTLEMENT_SCHEDULED', userId: ok.id } })).toBe(1);
  });

  it('settles a soft-deleted freelancer without notifying them', async () => {
    const freelancer = await makeFreelancer();
    await approvedItem(freelancer, TUESDAY);
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    expect(await prisma.settlement.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('ignores project soft-deletion', async () => {
    const freelancer = await makeFreelancer();
    const { project } = await approvedItem(freelancer, TUESDAY);
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    await runWeeklyBatch(PERIOD_START, BATCH_AT);

    expect((await prisma.settlement.findFirstOrThrow()).itemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------------------------

describe('settlement.payout behind JOB_PAYOUT_ENABLED', () => {
  it.each([['unset', undefined], ['false', 'false'], ['anything but true', '1']])(
    'with the flag %s, a due payout is held PENDING: not claimed, not counted, no transfer',
    async (_label, value) => {
      if (value === undefined) delete process.env.JOB_PAYOUT_ENABLED;
      else process.env.JOB_PAYOUT_ENABLED = value;
      const freelancer = await makeFreelancer();
      await makePayoutAccount(freelancer);
      const settlement = await scheduled(freelancer);

      const result = await runJobs(PAYOUT_AT);

      expect(result.claimed).toBe(0);
      const [job] = await jobsOf('settlement.payout');
      expect(job).toMatchObject({ status: 'PENDING', attempts: 0, lockedBy: null });
      expect(job.runAt.toISOString()).toBe(PAYOUT_AT.toISOString());
      expect(await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({
        status: 'SCHEDULED',
        payoutAttempts: 0,
      });
    },
  );

  it('other due jobs still run while payouts are held', async () => {
    process.env.JOB_PAYOUT_ENABLED = 'false';
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    await scheduled(freelancer);
    await enqueueBatch(new Date(BATCH_AT.getTime() + 7 * DAY_MS));

    const result = await runJobs(new Date(BATCH_AT.getTime() + 7 * DAY_MS));

    expect(result.claimed).toBe(1);
    expect((await jobsOf('settlement.weeklyBatch')).map((job) => job.status)).toContain('SUCCEEDED');
    expect((await jobsOf('settlement.payout'))[0].status).toBe('PENDING');
  });

  it('turning the flag on pays the held payout on the next pass', async () => {
    process.env.JOB_PAYOUT_ENABLED = 'false';
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    await runJobs(PAYOUT_AT);

    process.env.JOB_PAYOUT_ENABLED = 'true';
    const later = new Date(PAYOUT_AT.getTime() + 3 * DAY_MS);
    await runJobs(later);

    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({
      status: 'PAID',
      payoutAttempts: 1,
    });
    expect((await jobsOf('settlement.payout'))[0].status).toBe('SUCCEEDED');
  });
});

describe('settlement.payout', () => {
  it('pays to the account on file: PROCESSING snapshot, then PAID with a reference', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer, { bankCode: '090', accountNumber: '3333012345678' });
    const settlement = await scheduled(freelancer);

    await runJobs(PAYOUT_AT);

    const paid = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(paid).toMatchObject({
      status: 'PAID',
      payoutAttempts: 1,
      bankName: '카카오뱅크',
      accountNumberMasked: '*********5678',
      accountHolder: freelancer.name,
      failureReason: null,
    });
    expect(paid.providerReference).toMatch(/^log_/);
    expect(paid.paidAt!.toISOString()).toBe(PAYOUT_AT.toISOString());
    const notices = await prisma.notification.findMany({ where: { type: 'SETTLEMENT_PAID' } });
    expect(notices).toMatchObject([{ userId: freelancer.id, href: `/settlements/${settlement.id}` }]);
  });

  it('does nothing before the payout date', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);

    await runJobs(new Date(PAYOUT_AT.getTime() - 1));

    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('SCHEDULED');
  });

  it('holds a settlement without a payout account: ON_HOLD, attempts unchanged, notified', async () => {
    const freelancer = await makeFreelancer();
    const settlement = await scheduled(freelancer);

    await runJobs(PAYOUT_AT);

    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({
      status: 'ON_HOLD',
      payoutAttempts: 0,
    });
    const notices = await prisma.notification.findMany({ where: { type: 'SETTLEMENT_ON_HOLD' } });
    expect(notices).toMatchObject([{ userId: freelancer.id, href: '/settlements/account' }]);
  });

  it('holds a soft-deleted freelancer even with an account, without notifying', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    await runJobs(PAYOUT_AT);

    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('ON_HOLD');
    expect(await prisma.notification.count({ where: { type: { startsWith: 'SETTLEMENT_' } } })).toBe(1); // only SCHEDULED, before deletion
  });

  it('retries a failed transfer every 24 h, three attempts in all, then fails for good', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    setPayoutProvider(failingProvider());

    let at = PAYOUT_AT;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await runJobs(at);
      const failed = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
      expect(failed).toMatchObject({ status: 'FAILED', payoutAttempts: attempt, failureReason: `bank rejected transfer #${attempt}` });
      at = new Date(at.getTime() + DAY_MS);
      expect(failed.scheduledPayoutAt.toISOString()).toBe(at.toISOString());
      expect(await prisma.notification.count({ where: { type: 'SETTLEMENT_FAILED' } })).toBe(0);
    }

    await runJobs(at);
    const final = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(final).toMatchObject({ status: 'FAILED', payoutAttempts: 3 });
    expect(final.scheduledPayoutAt.toISOString()).toBe(at.toISOString());
    const notices = await prisma.notification.findMany({ where: { type: 'SETTLEMENT_FAILED' } });
    expect(notices).toMatchObject([{ userId: freelancer.id, href: `/settlements/${settlement.id}` }]);
    expect(await prisma.job.count({ where: { type: 'settlement.payout', status: 'PENDING' } })).toBe(0);

    // Nothing further happens, however long we wait.
    await runJobs(new Date(at.getTime() + 10 * DAY_MS));
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).payoutAttempts).toBe(3);
  });

  it('a retry that succeeds pays the settlement', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    setPayoutProvider(failingProvider(1));

    await runJobs(PAYOUT_AT);
    await runJobs(new Date(PAYOUT_AT.getTime() + DAY_MS));

    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({
      status: 'PAID',
      payoutAttempts: 2,
      providerReference: 'ref-2',
      failureReason: null,
    });
  });

  it('a retry finding the account deleted puts the settlement ON_HOLD', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    setPayoutProvider(failingProvider(1));
    await runJobs(PAYOUT_AT);
    await prisma.payoutAccount.deleteMany({ where: { userId: freelancer.id } });

    await runJobs(new Date(PAYOUT_AT.getTime() + DAY_MS));

    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({
      status: 'ON_HOLD',
      payoutAttempts: 1,
    });
  });

  it('a superseded job (its scheduledPayoutAt no longer matches) is a no-op', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    await prisma.settlement.update({ where: { id: settlement.id }, data: { scheduledPayoutAt: new Date(PAYOUT_AT.getTime() + 7 * DAY_MS) } });

    await runJobs(PAYOUT_AT);

    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('SCHEDULED');
    const [job] = await jobsOf('settlement.payout');
    expect(job.status).toBe('SUCCEEDED');
  });

  it('a settlement stuck in PROCESSING is never retried automatically', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer);
    await prisma.settlement.update({ where: { id: settlement.id }, data: { status: 'PROCESSING', payoutAttempts: 1 } });
    const provider = { transfer: vi.fn(async () => ({ reference: 'never' })) };
    setPayoutProvider(provider);

    await runJobs(PAYOUT_AT);

    expect(provider.transfer).not.toHaveBeenCalled();
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('PROCESSING');
  });

  it('pays however small the settlement is: no minimum payout', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer, 9);
    expect(settlement.netAmount).toBe(9);

    await runJobs(PAYOUT_AT);

    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('PAID');
  });

  /**
   * The payout decision and an account deletion serialize on the freelancer's user row.
   * With a slow transfer, only these outcomes are possible: the deletion commits first and the
   * payout holds; or the payout reaches PROCESSING first, the deletion is refused (409) and the
   * transfer completes; or the whole payout finished before the deletion started.
   */
  it('a payout racing an account deletion ends in a consistent state', async () => {
    const outcomes = new Set<string>();
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const freelancer = await makeFreelancer();
      await makePayoutAccount(freelancer);
      const settlement = await scheduled(freelancer);
      const transfer = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { reference: `slow-${iteration}` };
      });
      setPayoutProvider({ transfer });
      await Promise.all([1, 2, 3].map(() => authed(freelancer).get('/api/users/me/payout-account')));

      const [outcome, deletion] = await Promise.all([
        runPayout(settlement.id, settlement.scheduledPayoutAt.toISOString(), PAYOUT_AT),
        authed(freelancer).delete('/api/users/me/payout-account'),
      ]);

      const stored = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
      const accounts = await prisma.payoutAccount.count({ where: { userId: freelancer.id } });
      const state = `${outcome}/${stored.status}/${deletion.status}/${accounts}`;
      expect([
        'on_hold/ON_HOLD/200/0', // deletion first
        'paid/PAID/409/1', // payout reached PROCESSING first
        'paid/PAID/200/0', // payout finished before the deletion began
      ], `iteration ${iteration}`).toContain(state);
      if (stored.status === 'ON_HOLD') expect(transfer).not.toHaveBeenCalled();
      if (stored.status === 'PAID') expect(stored.accountNumberMasked).toBe('********6789');
      outcomes.add(state);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  /**
   * The same, deterministically: an account created while the payout decides must never leave the
   * settlement ON_HOLD. The test holds the settlement row so the payout stops after reading "no
   * account" and before writing ON_HOLD, then fires the PUT. With the user-row lock the PUT waits
   * for the payout, sees ON_HOLD and reschedules it. Without it the PUT commits in the gap,
   * finds nothing ON_HOLD to reschedule, and the payout then holds a settlement whose freelancer
   * has an account.
   */
  it('an account created mid-decision is never left behind an ON_HOLD settlement', async () => {
    const freelancer = await makeFreelancer();
    const settlement = await scheduled(freelancer);
    await Promise.all([1, 2, 3].map(() => authed(freelancer).get('/api/users/me/payout-account')));
    // The holder and the poll run on their own pool, so the app's pool only has to fit the
    // payout's and the PUT's transactions — see `sideClient`.
    const side = sideClient();
    const waiting = async () => (await side.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)[0].n;
    const until = async (done: () => Promise<boolean> | boolean) => {
      for (const deadline = Date.now() + 3_000; Date.now() < deadline && !(await done());) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    let release = () => {};
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Settlement" WHERE id = ${settlement.id} FOR UPDATE`;
      holding();
      await released;
    }, { timeout: 10_000 });
    try {
      await held;

      const payout = runPayout(settlement.id, settlement.scheduledPayoutAt.toISOString(), PAYOUT_AT);
      await until(async () => (await waiting()) >= 1); // the payout is parked on its ON_HOLD write
      let putDone = false;
      const put = authed(freelancer).put('/api/users/me/payout-account')
        .send({ bankCode: '004', accountNumber: '110123456789', holderName: freelancer.name })
        .then((res) => { putDone = true; return res; });
      await until(async () => putDone || (await waiting()) >= 2); // committed, or queued on the user row
      release();
      await holder;
      const [outcome, res] = await Promise.all([payout, put]);

      expect(outcome).toBe('on_hold');
      expect(res.status).toBe(200);
      expect(await prisma.payoutAccount.count({ where: { userId: freelancer.id } })).toBe(1);
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('SCHEDULED');
    } finally {
      release();
      await holder.catch(() => {});
      await side.$disconnect();
    }
  });

  it('transfers the netAmount of the settlement it moved to PROCESSING', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const settlement = await scheduled(freelancer, 2_000_000);
    const provider = { transfer: vi.fn(async () => ({ reference: 'r' })) };
    setPayoutProvider(provider);

    await runJobs(PAYOUT_AT);

    expect(provider.transfer).toHaveBeenCalledWith(expect.objectContaining({
      settlementId: settlement.id,
      attempt: 1,
      amount: 1_780_000,
      bankCode: '004',
      accountNumber: '110123456789',
    }));
  });

  it('ON_HOLD → register an account → rescheduled → PAID, and still pays after the project is deleted', async () => {
    // A week in the past, so the payout that put it ON_HOLD ran before the real clock's "now" —
    // the reschedule is always strictly after now, as it is in production.
    const pastStart = new Date('2020-01-05T15:00:00.000Z'); // Mon 2020-01-06 00:00 KST
    const pastPayout = new Date('2020-01-15T01:00:00.000Z'); // Wed 2020-01-15 10:00 KST
    const freelancer = await makeFreelancer();
    await approvedItem(freelancer, new Date('2020-01-07T05:00:00.000Z'));
    await runWeeklyBatch(pastStart, new Date('2020-01-12T18:00:00.000Z'));
    const settlement = await prisma.settlement.findFirstOrThrow();
    expect(settlement.scheduledPayoutAt.toISOString()).toBe(pastPayout.toISOString());
    await runJobs(pastPayout);
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('ON_HOLD');
    const project = await prisma.project.findFirstOrThrow();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).put('/api/users/me/payout-account').send({
      bankCode: '004', accountNumber: '110-123-456789', holderName: freelancer.name,
    });
    expect(res.status).toBe(200);
    expect(res.body.rescheduledCount).toBe(1);

    const rescheduled = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(rescheduled.status).toBe('SCHEDULED');
    expect(rescheduled.scheduledPayoutAt > new Date()).toBe(true);
    await runJobs(rescheduled.scheduledPayoutAt);

    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('PAID');
    const detail = await authed(freelancer).get(`/api/settlements/${settlement.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.items[0]).toMatchObject({ projectId: project.id, projectDeleted: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

describe('GET /api/settlements', () => {
  it("lists the caller's settlements newest period first, with status filter and paging", async () => {
    const freelancer = await makeFreelancer();
    const older = await scheduled(freelancer);
    await prisma.settlement.update({ where: { id: older.id }, data: { status: 'PAID' } });
    await approvedItem(freelancer, new Date(PERIOD_END.getTime() + DAY_MS));
    await runWeeklyBatch(PERIOD_END, new Date(BATCH_AT.getTime() + 7 * DAY_MS));
    await scheduled(await makeFreelancer()); // someone else's

    const all = await authed(freelancer).get('/api/settlements');
    const paid = await authed(freelancer).get('/api/settlements?status=PAID');
    const paged = await authed(freelancer).get('/api/settlements?limit=1&page=2');

    expect(all.status).toBe(200);
    expect(all.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    expect(all.body.settlements.map((s: { periodStart: string }) => s.periodStart)).toEqual([
      PERIOD_END.toISOString(),
      PERIOD_START.toISOString(),
    ]);
    expect(all.body.settlements[0]).not.toHaveProperty('items');
    expect(paid.body.settlements.map((s: { id: string }) => s.id)).toEqual([older.id]);
    expect(paged.body.settlements.map((s: { id: string }) => s.id)).toEqual([older.id]);
  });

  it.each(['?status=DONE', '?page=0', '?limit=1.5', '?page=999999999999999999'])('400s on %s', async (query) => {
    const freelancer = await makeFreelancer();
    expect((await authed(freelancer).get(`/api/settlements${query}`)).status).toBe(400);
  });

  it('is FREELANCER-only', async () => {
    const client = await makeClient();
    const res = await authed(client).get('/api/settlements');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Insufficient permissions');
  });
});

describe('GET /api/settlements/summary', () => {
  it('is all zeros for a freelancer with nothing yet', async () => {
    const freelancer = await makeFreelancer();
    const before = new Date();

    const res = await authed(freelancer).get('/api/settlements/summary');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      unsettled: { count: 0, gross: 0, fee: 0, vat: 0, net: 0 },
      scheduled: { count: 0, net: 0 },
      onHold: { count: 0, net: 0 },
      failed: { count: 0, net: 0 },
      paidTotal: 0,
      nextPayoutAt: null,
      hasPayoutAccount: false,
    });
    expect(res.body.nextBatchAt).toBe(nextKstWeekday(before, 1, 3).toISOString());
  });

  it('puts every settlement in exactly one bucket', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    const make = async (status: 'SCHEDULED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'ON_HOLD', net: number, weeks: number, attempts = 0) =>
      prisma.settlement.create({
        data: {
          freelancerId: freelancer.id,
          periodStart: new Date(PERIOD_START.getTime() - weeks * 7 * DAY_MS),
          periodEnd: new Date(PERIOD_END.getTime() - weeks * 7 * DAY_MS),
          scheduledPayoutAt: new Date(PAYOUT_AT.getTime() - weeks * 7 * DAY_MS),
          status,
          itemCount: 1,
          grossAmount: net,
          feeAmount: 0,
          feeVatAmount: 0,
          netAmount: net,
          payoutAttempts: attempts,
        },
      });
    await make('SCHEDULED', 100, 0);
    await make('PROCESSING', 200, 1, 1);
    await make('FAILED', 300, 2, 1); // retry pending → scheduled
    await make('FAILED', 400, 3, 3); // final → failed
    await make('ON_HOLD', 500, 4);
    await make('PAID', 600, 5, 1);
    await make('PAID', 700, 6, 1);
    await approvedItem(freelancer, TUESDAY, 15_005);

    const res = await authed(freelancer).get('/api/settlements/summary');

    expect(res.body).toMatchObject({
      unsettled: { count: 1, gross: 15_005, fee: 1_500, vat: 150, net: 13_355 },
      scheduled: { count: 3, net: 600 },
      onHold: { count: 1, net: 500 },
      failed: { count: 1, net: 400 },
      paidTotal: 1_300,
      hasPayoutAccount: true,
    });
    expect(res.body.nextPayoutAt).toBe(new Date(PAYOUT_AT.getTime() - 2 * 7 * DAY_MS).toISOString());
  });
});

describe('GET /api/settlements/:id', () => {
  it('returns the settlement with its items in approval order', async () => {
    const freelancer = await makeFreelancer();
    const late = await approvedItem(freelancer, new Date(TUESDAY.getTime() + DAY_MS), 2_000_000);
    const early = await approvedItem(freelancer, TUESDAY, 1_000_000);
    await runWeeklyBatch(PERIOD_START, BATCH_AT);
    const settlement = await prisma.settlement.findFirstOrThrow();

    const res = await authed(freelancer).get(`/api/settlements/${settlement.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: settlement.id, status: 'SCHEDULED', itemCount: 2, netAmount: 890_000 + 1_780_000 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: early.item.id,
      milestoneId: early.milestone.id,
      milestoneTitle: early.milestone.title,
      milestoneSequence: 1,
      contractId: early.contract.id,
      projectId: early.project.id,
      projectTitle: early.project.title,
      projectDeleted: false,
      grossAmount: 1_000_000,
      feeRateBps: 1000,
      feeAmount: 100_000,
      feeVatAmount: 10_000,
      netAmount: 890_000,
      approvedAt: TUESDAY.toISOString(),
    });
    expect(res.body.items[1].id).toBe(late.item.id);
  });
});
