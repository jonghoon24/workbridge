import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeFreelancer, makePayoutAccount } from './helpers/factories';
import { decryptAccountNumber } from '../src/lib/payoutAccountCrypto';
import { nextKstWeekday } from '../src/lib/time';

/** The payout account — reading, registering and deleting it, and rescheduling held payouts. */

const PERIOD = {
  periodStart: new Date('2020-01-05T15:00:00.000Z'),
  periodEnd: new Date('2020-01-12T15:00:00.000Z'),
  scheduledPayoutAt: new Date('2020-01-15T01:00:00.000Z'),
};

function settlementFor(user: User, status: 'SCHEDULED' | 'PROCESSING' | 'ON_HOLD' | 'FAILED', weeksBack = 0, extra: Record<string, unknown> = {}) {
  const shift = (d: Date) => new Date(d.getTime() - weeksBack * 7 * 86_400_000);
  return prisma.settlement.create({
    data: {
      freelancerId: user.id,
      periodStart: shift(PERIOD.periodStart),
      periodEnd: shift(PERIOD.periodEnd),
      scheduledPayoutAt: shift(PERIOD.scheduledPayoutAt),
      status,
      itemCount: 1,
      grossAmount: 1_000_000,
      feeAmount: 100_000,
      feeVatAmount: 10_000,
      netAmount: 890_000,
      ...extra,
    },
  });
}

const put = (user: User, body: Record<string, unknown>) => authed(user).put('/api/users/me/payout-account').send(body);

describe('GET /api/users/me/payout-account', () => {
  it('is { payoutAccount: null } before one is registered', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get('/api/users/me/payout-account');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ payoutAccount: null });
  });

  it('shows the account masked, never the full number', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer, { bankCode: '092', accountNumber: '100012345678' });

    const res = await authed(freelancer).get('/api/users/me/payout-account');

    expect(res.body.payoutAccount).toEqual({
      bankCode: '092',
      bankName: '토스뱅크',
      accountNumberMasked: '********5678',
      holderName: freelancer.name,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('100012345678');
  });
});

describe('PUT /api/users/me/payout-account', () => {
  it('registers an account: digits only, encrypted at rest, masked response', async () => {
    const freelancer = await makeFreelancer();

    const res = await put(freelancer, { bankCode: '004', accountNumber: ' 110-123 456-789 ', holderName: freelancer.name });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      payoutAccount: expect.objectContaining({ bankCode: '004', bankName: 'KB국민', accountNumberMasked: '********6789' }),
      rescheduledCount: 0,
    });
    expect(JSON.stringify(res.body)).not.toContain('110123456789');
    const stored = await prisma.payoutAccount.findUniqueOrThrow({ where: { userId: freelancer.id } });
    expect(stored.accountNumber).not.toContain('110123456789');
    expect(decryptAccountNumber(stored.accountNumber, freelancer.id)).toBe('110123456789');
  });

  it('replaces an existing account in place', async () => {
    const freelancer = await makeFreelancer();
    const before = await makePayoutAccount(freelancer);

    const res = await put(freelancer, { bankCode: '088', accountNumber: '1234567890', holderName: freelancer.name });

    expect(res.status).toBe(200);
    const accounts = await prisma.payoutAccount.findMany({ where: { userId: freelancer.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: before.id, bankCode: '088' });
    expect(decryptAccountNumber(accounts[0].accountNumber, freelancer.id)).toBe('1234567890');
  });

  it('matches the holder ignoring whitespace and letter case', async () => {
    const freelancer = await makeFreelancer({ name: 'Jane Doe' });

    expect((await put(freelancer, { bankCode: '004', accountNumber: '1234567890', holderName: '  jane  DOE ' })).status).toBe(200);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown bank code', { bankCode: '999', accountNumber: '1234567890' }, 'bankCode: Unknown bank code'],
    ['a missing bank code', { accountNumber: '1234567890' }, 'bankCode: Unknown bank code'],
    ['9 digits', { bankCode: '004', accountNumber: '123456789' }, 'accountNumber: Account number must be 10 to 14 digits'],
    ['15 digits', { bankCode: '004', accountNumber: '123456789012345' }, 'accountNumber: Account number must be 10 to 14 digits'],
    ['letters', { bankCode: '004', accountNumber: '12345abcde' }, 'accountNumber: Account number must be 10 to 14 digits'],
    ['a blank holder', { bankCode: '004', accountNumber: '1234567890', holderName: '  ' }, 'holderName: Account holder is required'],
  ])('400s on %s', async (_label, body, message) => {
    const freelancer = await makeFreelancer();

    const res = await put(freelancer, { holderName: freelancer.name, ...body });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.payoutAccount.count()).toBe(0);
  });

  it('accepts exactly 10 and 14 digits', async () => {
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    expect((await put(a, { bankCode: '004', accountNumber: '1234567890', holderName: a.name })).status).toBe(200);
    expect((await put(b, { bankCode: '004', accountNumber: '12345678901234', holderName: b.name })).status).toBe(200);
  });

  it("400s when the holder is not the member's name", async () => {
    const freelancer = await makeFreelancer({ name: '박지윤' });

    const res = await put(freelancer, { bankCode: '004', accountNumber: '1234567890', holderName: '박지원' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Account holder must match your name' } });
  });

  it('409s while a payout is PROCESSING, and changes nothing', async () => {
    const freelancer = await makeFreelancer();
    const before = await makePayoutAccount(freelancer);
    await settlementFor(freelancer, 'PROCESSING');

    const res = await put(freelancer, { bankCode: '088', accountNumber: '9999999999', holderName: freelancer.name });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Payout account cannot be changed while a payout is processing' } });
    expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { userId: freelancer.id } })).toMatchObject({
      bankCode: before.bankCode,
      accountNumber: before.accountNumber,
    });
  });

  it('reschedules every ON_HOLD settlement to the next Wednesday 10:00 KST and enqueues its payout', async () => {
    const freelancer = await makeFreelancer();
    const heldA = await settlementFor(freelancer, 'ON_HOLD', 0, { failureReason: 'old', payoutAttempts: 1 });
    const heldB = await settlementFor(freelancer, 'ON_HOLD', 1);
    const other = await settlementFor(freelancer, 'SCHEDULED', 2);
    const before = new Date();

    const res = await put(freelancer, { bankCode: '004', accountNumber: '1234567890', holderName: freelancer.name });
    const after = new Date();

    expect(res.status).toBe(200);
    expect(res.body.rescheduledCount).toBe(2);
    const expected = [nextKstWeekday(before, 3, 10).toISOString(), nextKstWeekday(after, 3, 10).toISOString()];
    for (const id of [heldA.id, heldB.id]) {
      const s = await prisma.settlement.findUniqueOrThrow({ where: { id } });
      expect(s.status).toBe('SCHEDULED');
      expect(expected).toContain(s.scheduledPayoutAt.toISOString());
      expect(s.failureReason).toBeNull();
      const job = await prisma.job.findUniqueOrThrow({
        where: { dedupeKey: `settlement.payout:${id}:${s.scheduledPayoutAt.toISOString()}` },
      });
      expect(job.runAt.toISOString()).toBe(s.scheduledPayoutAt.toISOString());
    }
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: heldA.id } })).payoutAttempts).toBe(1);
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: other.id } })).scheduledPayoutAt.toISOString())
      .toBe(other.scheduledPayoutAt.toISOString());
  });
});

describe('registering an account reschedules a held payout without reusing its job key', () => {
  it('moves a hold whose date is the coming Wednesday to the Wednesday after, with a live job', async () => {
    const freelancer = await makeFreelancer();
    // As a runner whose clock is ahead would leave it: held on the coming Wednesday, its
    // payout job already SUCCEEDED under that key.
    const coming = nextKstWeekday(new Date(), 3, 10);
    const held = await settlementFor(freelancer, 'ON_HOLD', 0, { scheduledPayoutAt: coming });
    await prisma.job.create({
      data: {
        type: 'settlement.payout',
        payload: { settlementId: held.id, scheduledPayoutAt: coming.toISOString() },
        runAt: coming,
        status: 'SUCCEEDED',
        dedupeKey: `settlement.payout:${held.id}:${coming.toISOString()}`,
      },
    });

    const res = await put(freelancer, { bankCode: '004', accountNumber: '1234567890', holderName: freelancer.name });

    expect(res.status).toBe(200);
    expect(res.body.rescheduledCount).toBe(1);
    const after = await prisma.settlement.findUniqueOrThrow({ where: { id: held.id } });
    const nextWeek = new Date(coming.getTime() + 7 * 86_400_000);
    expect(after.scheduledPayoutAt.toISOString()).toBe(nextWeek.toISOString());
    const job = await prisma.job.findUniqueOrThrow({
      where: { dedupeKey: `settlement.payout:${held.id}:${nextWeek.toISOString()}` },
    });
    expect(job.status).toBe('PENDING');
  });
});

describe('DELETE /api/users/me/payout-account', () => {
  it('removes the account', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);

    const res = await authed(freelancer).delete('/api/users/me/payout-account');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ payoutAccount: null });
    expect(await prisma.payoutAccount.count()).toBe(0);
  });

  it('is idempotent when there is none', async () => {
    const freelancer = await makeFreelancer();
    expect((await authed(freelancer).delete('/api/users/me/payout-account')).status).toBe(200);
  });

  it('409s while a payout is PROCESSING', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    await settlementFor(freelancer, 'PROCESSING');

    const res = await authed(freelancer).delete('/api/users/me/payout-account');

    expect(res.status).toBe(409);
    expect(await prisma.payoutAccount.count()).toBe(1);
  });

  it('is allowed with a SCHEDULED settlement, which then uses whatever exists at payout time', async () => {
    const freelancer = await makeFreelancer();
    await makePayoutAccount(freelancer);
    await settlementFor(freelancer, 'SCHEDULED');

    expect((await authed(freelancer).delete('/api/users/me/payout-account')).status).toBe(200);
  });
});
