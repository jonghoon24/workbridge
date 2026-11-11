import { describe, expect, it } from 'vitest';

import { authed } from './helpers/api';
import { prisma, sideClient } from './helpers/db';
import { makeContractScenario, makeMilestone } from './helpers/factories';
import { DAY_MS, kstDateString, kstDateToEndOfDay } from '../src/lib/time';
import type { FieldErrorCode } from '../src/lib/errorCodes';
import { invalidBody, invalidBodyFor } from './helpers/errors';

/**
 * The milestone plan — reading and replacing it, and the plan rules (count, amounts, sum,
 * due dates). The 401/403/
 * ownership matrix for these routes lives in authorization.test.ts.
 */

const today = () => kstDateString(new Date());
const inDays = (n: number) => kstDateString(new Date(Date.now() + n * DAY_MS));

type Item = { title: string; amount: number; dueDate: string; description?: string | null };

/** A valid two-milestone plan for the default 4,000,000 contract. */
const twoStep = (): Item[] => [
  { title: '설계', amount: 1_500_000, dueDate: inDays(10), description: '화면 설계' },
  { title: '개발', amount: 2_500_000, dueDate: inDays(30) },
];

function put(user: { id: string; email: string; role: 'CLIENT' | 'FREELANCER' }, contractId: string, milestones: unknown) {
  return authed(user).put(`/api/contracts/${contractId}/milestones`).send({ milestones });
}

describe('GET /api/contracts/:id/milestones', () => {
  it('returns milestone objects in sequence order with the summary, to either party', async () => {
    const { client, freelancer, contract, milestone } = await makeContractScenario({ milestone: { amount: 1_000_000 } });
    const second = await makeMilestone(contract.id, { amount: 3_000_000 });

    const asClient = await authed(client).get(`/api/contracts/${contract.id}/milestones`);
    const asFreelancer = await authed(freelancer).get(`/api/contracts/${contract.id}/milestones`);

    expect(asClient.status).toBe(200);
    expect(asFreelancer.body).toEqual(asClient.body);
    expect(asClient.body.milestones.map((m: { id: string }) => m.id)).toEqual([milestone.id, second.id]);
    expect(asClient.body.milestones[1]).toMatchObject({
      sequence: 2,
      amount: 3_000_000,
      status: 'PENDING',
      payment: null,
      latestSubmission: null,
      autoApproveAt: null,
      payoutPreview: { gross: 3_000_000, fee: 300_000, vat: 30_000, net: 2_670_000 },
    });
    expect(asClient.body.milestoneSummary).toEqual({
      count: 2,
      contractAmount: 4_000_000,
      fundedAmount: 0,
      approvedAmount: 0,
      approvedCount: 0,
    });
  });
});

describe('PUT /api/contracts/:id/milestones — success', () => {
  it('replaces the whole plan, numbering by array order, and stores KST end-of-day due dates', async () => {
    const { client, contract, milestone } = await makeContractScenario();
    const plan = twoStep();

    const res = await put(client, contract.id, plan);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['contract', 'milestones']);
    expect(res.body.contract).toEqual({
      id: contract.id,
      status: 'PENDING',
      amount: 4_000_000,
      endDate: kstDateToEndOfDay(plan[1].dueDate).toISOString(),
      clientSigned: false,
      freelancerSigned: false,
    });
    expect(res.body.milestones).toHaveLength(2);
    expect(res.body.milestones[0]).toMatchObject({
      sequence: 1,
      title: '설계',
      description: '화면 설계',
      amount: 1_500_000,
      status: 'PENDING',
      dueDate: kstDateToEndOfDay(plan[0].dueDate).toISOString(),
    });
    expect(res.body.milestones[1]).toMatchObject({ sequence: 2, title: '개발', description: null });

    expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).toBeNull();
    expect(await prisma.milestone.count({ where: { contractId: contract.id } })).toBe(2);
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(stored.endDate.toISOString()).toBe(kstDateToEndOfDay(plan[1].dueDate).toISOString());
  });

  it('accepts a due date of today in KST and equal consecutive dates', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await put(client, contract.id, [
      { title: 'a', amount: 2_000_000, dueDate: today() },
      { title: 'b', amount: 2_000_000, dueDate: today() },
    ]);

    expect(res.status).toBe(200);
  });

  it('accepts exactly 10 milestones and exactly 10,000 won', async () => {
    const { client, contract } = await makeContractScenario({ contract: { amount: 1_000_000 } });
    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `단계 ${i + 1}`,
      amount: i === 0 ? 10_000 : 110_000,
      dueDate: inDays(5 + i),
    }));

    const res = await put(client, contract.id, items);

    expect(res.status).toBe(200);
    expect(res.body.milestones).toHaveLength(10);
  });

  it('resets both signatures and notifies the freelancer when a signature was present', async () => {
    const { client, freelancer, contract } = await makeContractScenario({ contract: { clientSigned: true } });

    const res = await put(client, contract.id, twoStep());

    expect(res.status).toBe(200);
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(stored).toMatchObject({ clientSigned: false, freelancerSigned: false, status: 'PENDING' });
    const notifications = await prisma.notification.findMany({ where: { type: 'MILESTONE_PLAN_UPDATED' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ userId: freelancer.id, href: `/contracts/${contract.id}` });
  });

  it('does not notify when no one had signed', async () => {
    const { client, contract } = await makeContractScenario();

    await put(client, contract.id, twoStep());

    expect(await prisma.notification.count()).toBe(0);
  });

  it('does not notify a soft-deleted freelancer', async () => {
    const { client, freelancer, contract } = await makeContractScenario({ contract: { freelancerSigned: true } });
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    const res = await put(client, contract.id, twoStep());

    expect(res.status).toBe(200);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('produces a plan the contract can then be signed with', async () => {
    const { client, freelancer, contract } = await makeContractScenario();
    await put(client, contract.id, twoStep());

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.milestoneSummary.count).toBe(2);
  });
});

describe('PUT /api/contracts/:id/milestones — refusals', () => {
  const longText = (n: number) => 'x'.repeat(n);

  it.each<[string, () => unknown, string, FieldErrorCode]>([
    ['no milestones', () => [], 'milestones: A contract must have between 1 and 10 milestones', 'REQUIRED'],
    ['eleven milestones', () => Array.from({ length: 11 }, (_, i) => ({ title: `${i}`, amount: 10_000, dueDate: inDays(5) })), 'milestones: A contract must have between 1 and 10 milestones', 'TOO_LARGE'],
    ['an empty title', () => [{ title: '   ', amount: 4_000_000, dueDate: inDays(5) }], 'milestones.0.title: Title is required', 'REQUIRED'],
    ['a 101-character title', () => [{ title: longText(101), amount: 4_000_000, dueDate: inDays(5) }], 'milestones.0.title: Title must be at most 100 characters', 'TOO_LARGE'],
    ['a 2001-character description', () => [{ title: 't', description: longText(2001), amount: 4_000_000, dueDate: inDays(5) }], 'milestones.0.description: Description must be at most 2000 characters', 'TOO_LARGE'],
    ['a fractional amount', () => [{ title: 't', amount: 3_999_999.5, dueDate: inDays(5) }], 'milestones.0.amount: Amount must be a whole number of won', 'INVALID'],
    ['an amount below 10,000', () => [{ title: 'a', amount: 3_990_001, dueDate: inDays(5) }, { title: 'b', amount: 9_999, dueDate: inDays(6) }], 'milestones.1.amount: Amount must be at least 10000', 'TOO_SMALL'],
    ['a malformed date', () => [{ title: 't', amount: 4_000_000, dueDate: '2026/12/01' }], 'milestones.0.dueDate: Due date must be a YYYY-MM-DD date', 'INVALID'],
    ['an impossible date', () => [{ title: 't', amount: 4_000_000, dueDate: '2099-02-30' }], 'milestones.0.dueDate: Due date must be a YYYY-MM-DD date', 'INVALID'],
    ['yesterday', () => [{ title: 't', amount: 4_000_000, dueDate: inDays(-1) }], 'milestones.0.dueDate: Due date cannot be in the past', 'TOO_SMALL'],
    ['decreasing dates', () => [{ title: 'a', amount: 2_000_000, dueDate: inDays(10) }, { title: 'b', amount: 2_000_000, dueDate: inDays(9) }], 'milestones.1.dueDate: Due dates must not decrease', 'CONFLICT'],
    // No zod default message (`Required`, `Expected number, received string`) reaches the client.
    ['a missing title', () => [{ amount: 4_000_000, dueDate: inDays(5) }], 'milestones.0.title: Title is required', 'REQUIRED'],
    ['a string amount', () => [{ title: 't', amount: '4000000', dueDate: inDays(5) }], 'milestones.0.amount: Amount must be a whole number of won', 'INVALID'],
    ['a missing amount', () => [{ title: 't', dueDate: inDays(5) }], 'milestones.0.amount: Amount must be a whole number of won', 'REQUIRED'],
    ['a missing due date', () => [{ title: 't', amount: 4_000_000 }], 'milestones.0.dueDate: Due date must be a YYYY-MM-DD date', 'REQUIRED'],
  ])('400s on %s with an exact message', async (_label, items, message, code) => {
    const { client, contract, milestone } = await makeContractScenario();

    const res = await put(client, contract.id, items());

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBodyFor(code, message));
    expect((await prisma.milestone.findMany({ where: { contractId: contract.id } })).map((m) => m.id)).toEqual([milestone.id]);
  });

  it.each<[string, Record<string, unknown>, FieldErrorCode]>([
    ['a body without milestones', {}, 'REQUIRED'],
    ['milestones that are not a list', { milestones: 'x' }, 'INVALID'],
  ])('400s on %s with the milestone count message', async (_label, body, code) => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).put(`/api/contracts/${contract.id}/milestones`).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBody('milestones', code, 'milestones: A contract must have between 1 and 10 milestones'));
  });

  it('reports the first failing entry in array order: a past date on #0 wins over a blank title on #1', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await put(client, contract.id, [
      { title: 'a', amount: 2_000_000, dueDate: inDays(-1) },
      { title: '  ', amount: 2_000_000, dueDate: inDays(5) },
    ]);

    expect(res.body).toEqual(invalidBody('milestones.0.dueDate', 'TOO_SMALL', 'milestones.0.dueDate: Due date cannot be in the past'));
  });

  it('checks the date order only after every entry passed its own checks', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await put(client, contract.id, [
      { title: 'a', amount: 2_000_000, dueDate: inDays(9) },
      { title: 'b', amount: 2_000_000, dueDate: inDays(5) },
      { title: '', amount: 2_000_000, dueDate: inDays(10) },
    ]);

    expect(res.body).toEqual(invalidBody('milestones.2.title', 'REQUIRED', 'milestones.2.title: Title is required'));
  });

  it('accepts exactly 100 / 2000 characters (the inclusive bounds)', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await put(client, contract.id, [
      { title: longText(100), description: longText(2000), amount: 4_000_000, dueDate: inDays(5) },
    ]);

    expect(res.status).toBe(200);
  });

  it('validates before looking the contract up: a bad body on a missing id is 400, not 404', async () => {
    const client = (await makeContractScenario()).client;

    const res = await put(client, '00000000-0000-0000-0000-000000000000', []);

    expect(res.status).toBe(400);
  });

  it('400s when the amounts do not add up, naming the whole-won contract amount', async () => {
    const { client, contract } = await makeContractScenario({ contract: { amount: 2_500_000.5 } });

    const res = await put(client, contract.id, [{ title: 't', amount: 2_500_000, dueDate: inDays(5) }]);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Milestone amounts must add up to the contract amount (2500001)',
        fields: [{ path: 'milestones', code: 'CONFLICT' }],
      },
    });
  });

  it.each(['ACTIVE', 'COMPLETED'] as const)('409s on a %s contract, before the sum check', async (status) => {
    const { client, contract, milestone } = await makeContractScenario({
      contract: { status, clientSigned: true, freelancerSigned: true },
    });

    const res = await put(client, contract.id, [{ title: 't', amount: 1_000_000, dueDate: inDays(5) }]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'MILESTONE_PLAN_LOCKED', message: 'Milestone plan is locked once the contract is active' } });
    expect((await prisma.milestone.findMany({ where: { contractId: contract.id } })).map((m) => m.id)).toEqual([milestone.id]);
  });

  it('409s on a cancelled contract, leaving its plan as it was', async () => {
    const { client, contract, milestone } = await makeContractScenario({ contract: { status: 'CANCELLED' } });

    const res = await put(client, contract.id, twoStep());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONTRACT_CANCELLED', message: 'This contract has been cancelled' } });
    expect((await prisma.milestone.findMany({ where: { contractId: contract.id } })).map((m) => m.id)).toEqual([milestone.id]);
  });

  it("403s for a FREELANCER, even the contract's own (role gate)", async () => {
    const { freelancer, contract } = await makeContractScenario();

    const res = await put(freelancer, contract.id, twoStep());

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Insufficient permissions');
  });
});

describe('plan replacement racing a signature', () => {
  /**
   * Deterministic stale-read check: a signature lands (uncommitted, holding the contract row)
   * after the replacement has read the contract but before its transaction locks it. "A signature
   * was present" must come from the locked pre-image, so the freelancer is notified. A
   * replacement deciding from its earlier read, or from an unlocked read, would see no signature.
   */
  it('decides "a signature was present" from the locked row, not an earlier read', async () => {
    const { client, contract } = await makeContractScenario();
    await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));
    // The signer and the poll run on their own pool, so they never take the app's connections
    // — see `sideClient`.
    const side = sideClient();
    let release = () => {};
    let signed!: () => void;
    const signatureWritten = new Promise<void>((resolve) => { signed = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const signer = side.$transaction(async (tx) => {
      await tx.contract.update({ where: { id: contract.id }, data: { freelancerSigned: true } });
      signed();
      await released;
    }, { timeout: 10_000 });
    try {
      await signatureWritten;

      const replace = put(client, contract.id, twoStep()).then((res) => res);
      for (const deadline = Date.now() + 3_000; Date.now() < deadline;) {
        const [{ n }] = await side.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
        if (n >= 1) break; // the replacement is queued on the contract row
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      await signer;
      const res = await replace;

      expect(res.status).toBe(200);
      expect(res.body.contract).toMatchObject({ clientSigned: false, freelancerSigned: false });
      expect(await prisma.notification.count({ where: { type: 'MILESTONE_PLAN_UPDATED' } })).toBe(1);
    } finally {
      release();
      await signer.catch(() => {});
      await side.$disconnect();
    }
  });

  /**
   * The client has signed; the freelancer signs while the client replaces the plan. Whichever
   * commits first, the outcome is one of exactly two consistent states — never an ACTIVE
   * contract on a plan that was replaced after the signatures.
   */
  it('serializes on the contract row: either ACTIVE with the old plan, or PENDING and unsigned-by-client with the new one', async () => {
    const outcomes = new Set<string>();
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const { client, freelancer, contract, milestone } = await makeContractScenario({ contract: { clientSigned: true } });
      // Warm the pool so the two requests genuinely overlap.
      await Promise.all([1, 2, 3].map(() => authed(client).get('/api/contracts')));

      const [sign, replace] = await Promise.all([
        authed(freelancer).post(`/api/contracts/${contract.id}/sign`),
        put(client, contract.id, twoStep()),
      ]);

      const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
      const ids = (await prisma.milestone.findMany({ where: { contractId: contract.id } })).map((m) => m.id);
      expect(sign.status, `iteration ${iteration}`).toBe(200);

      if (replace.status === 409) {
        expect(stored.status).toBe('ACTIVE');
        expect(ids).toEqual([milestone.id]);
        outcomes.add('sign-first');
      } else {
        expect(replace.status).toBe(200);
        expect(stored.status).toBe('PENDING');
        expect(stored.clientSigned).toBe(false);
        expect(ids).not.toContain(milestone.id);
        expect(stored.freelancerSigned).toBe(true);
        outcomes.add('replace-first');
        // A signature was present before the replacement, so the freelancer was told.
        expect(await prisma.notification.count({
          where: { type: 'MILESTONE_PLAN_UPDATED', href: `/contracts/${contract.id}` },
        })).toBe(1);
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});
