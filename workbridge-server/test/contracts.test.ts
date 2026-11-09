import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeClient,
  makeContractScenario,
  makeFreelancer,
  makeMessage,
  makeMilestone,
  makePayment,
  makeSubmission,
} from './helpers/factories';

/**
 * Contracts — `/api/contracts`, plus the error envelope, authentication, authorization and
 * atomicity as they apply to these routes.
 *
 * A few tests pin still-undecided behavior rather than a decision — notably both parties' email
 * addresses being returned on the contract responses.
 */

/** The system events posted so far, oldest first. */
async function systemEvents(conversationId: string) {
  const messages = await prisma.message.findMany({
    where: { conversationId, kind: 'SYSTEM' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return messages.map((m) => m.systemEvent);
}

/** Every error body is exactly `{ error: { message } }`. */
function expectErrorEnvelope(body: unknown, message?: string) {
  expect(body).toEqual({ error: { message: message ?? expect.any(String) } });
}

/** Distinctive so a 500 caused by the injection cannot be confused with a real product error. */
const INJECTED = 'injected transaction failure';

type WatchedModel = 'contract' | 'project';

/** Delegates whose calls inside a transaction are recorded. Extend as new tests need it. */
const WATCHED_MODELS: readonly WatchedModel[] = ['contract', 'project'];

const asFunction = (value: unknown) => value as (...args: unknown[]) => unknown;

/** The slice of the transaction client the `observe` hooks below use. */
type TxReader = {
  contract: { findUnique: (args: { where: { id: string } }) => Promise<unknown> };
  project: { findUnique: (args: { where: { id: string } }) => Promise<unknown> };
};

/**
 * Forces one step of an interactive `prisma.$transaction` to reject, so atomicity can be tested
 * for real rather than inferred from the happy path.
 *
 * Mocked at the prisma-client boundary — `src/` is untouched. Note that spying on
 * `prisma.contract.update` would *not* work: Prisma hands the callback its own transaction
 * client, and `tx.contract` is a different delegate object from `prisma.contract`. So the spy
 * wraps `$transaction` itself and passes the callback a Proxy over `tx` that records every call
 * to a watched delegate and rejects the requested one. `vi.restoreAllMocks()` in `afterEach`
 * puts the real `$transaction` back.
 *
 * Two things keep these tests from passing for the wrong reason:
 * - `steps` logs every watched call, so a test can assert the failure landed on the intended
 *   statement and that the statements before it really ran.
 * - `observe` runs one read on the **unproxied** transaction client immediately before the
 *   rejection, so a test can show the earlier write was visible *inside* the transaction and is
 *   gone afterwards. Without that, "the row is unchanged" could equally mean the write never ran.
 */
function failTransactionStep(target: {
  model: WatchedModel;
  method: string;
  /** 1-based: which call to that `model.method` fails. Defaults to the first. */
  call?: number;
  /** Read the pre-failure state from inside the transaction, before it is rolled back. */
  observe?: (tx: TxReader) => Promise<unknown>;
}) {
  const failOn = target.call ?? 1;
  const steps: string[] = [];
  let matches = 0;
  let observed: unknown;

  // Bound before spying, so the wrapper invokes the real implementation and not itself.
  const runTransaction = asFunction(prisma.$transaction.bind(prisma));
  const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };

  const watchDelegate = (model: WatchedModel, delegate: object, tx: object) =>
    new Proxy(delegate, {
      get(delegateTarget, prop) {
        const method = Reflect.get(delegateTarget, prop);
        if (typeof method !== 'function') return method;

        return (...args: unknown[]) => {
          steps.push(`${model}.${String(prop)}`);
          if (model === target.model && prop === target.method) {
            matches += 1;
            if (matches === failOn) {
              return (async () => {
                if (target.observe) observed = await target.observe(tx as TxReader);
                throw new Error(INJECTED);
              })();
            }
          }
          return asFunction(method).apply(delegateTarget, args);
        };
      },
    });

  const watchTransactionClient = (tx: object) =>
    new Proxy(tx, {
      get(txTarget, prop) {
        const value = Reflect.get(txTarget, prop);
        if (WATCHED_MODELS.includes(prop as WatchedModel) && typeof value === 'object' && value) {
          return watchDelegate(prop as WatchedModel, value, txTarget);
        }
        return typeof value === 'function' ? asFunction(value).bind(txTarget) : value;
      },
    });

  vi.spyOn(client, '$transaction').mockImplementation((...args: unknown[]) => {
    const [first, ...rest] = args;
    // Only the interactive (callback) form is wrapped; the array form is passed straight through.
    if (typeof first !== 'function') return runTransaction(...args);
    const callback = asFunction(first);
    return runTransaction((tx: object) => callback(watchTransactionClient(tx)), ...rest);
  });

  return { steps, observed: () => observed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/contracts/:id', () => {
  it('lets the client read the contract', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: contract.id,
      status: 'PENDING',
      clientSigned: false,
      freelancerSigned: false,
      amount: 4_000_000,
    });
  });

  it('includes the project, both parties and the milestones with their payments', async () => {
    const { client, freelancer, project, contract, milestone } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'SUBMITTED', amount: 3_000_000 },
    });
    const second = await makeMilestone(contract.id, { amount: 1_000_000 });
    const payment = await makePayment(milestone.id, client.id, { status: 'COMPLETED' });
    const submission = await makeSubmission(milestone.id);

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({
      id: project.id,
      title: project.title,
      status: 'CLOSED',
    });
    expect(res.body.client).toMatchObject({ id: client.id, name: client.name });
    expect(res.body.freelancer).toMatchObject({ id: freelancer.id, name: freelancer.name });
    expect(res.body).not.toHaveProperty('payment');
    expect(res.body.milestones.map((m: { id: string }) => m.id)).toEqual([milestone.id, second.id]);
    expect(res.body.milestones[0]).toMatchObject({
      id: milestone.id,
      sequence: 1,
      status: 'SUBMITTED',
      payment: { id: payment.id, status: 'COMPLETED' },
      latestSubmission: { id: submission.id, round: 1, attachments: [] },
      payoutPreview: { gross: 3_000_000, fee: 300_000, vat: 30_000, net: 2_670_000 },
    });
    expect(res.body.milestones[0]).not.toHaveProperty('submissions');
    expect(res.body.milestones[1]).toMatchObject({ payment: null, latestSubmission: null });
  });

  it('reports the milestone summary, and empty reviews, for a fresh contract', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.milestoneSummary).toEqual({
      count: 1,
      contractAmount: 4_000_000,
      fundedAmount: 0,
      approvedAmount: 0,
      approvedCount: 0,
    });
    expect(res.body.reviews).toEqual([]);
  });

  it('counts funded and approved milestones in the summary; contractAmount is whole won', async () => {
    const { client, contract, milestone } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true, amount: 4_000_000.5 },
      milestone: { status: 'APPROVED', amount: 1_000_000 },
    });
    expect(milestone.status).toBe('APPROVED');
    await makeMilestone(contract.id, { status: 'SUBMITTED', amount: 2_000_000 });
    await makeMilestone(contract.id, { status: 'PENDING', amount: 1_000_001 });

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.body.milestoneSummary).toEqual({
      count: 3,
      contractAmount: 4_000_001,
      fundedAmount: 3_000_000,
      approvedAmount: 1_000_000,
      approvedCount: 1,
    });
  });

  it('returns reviews newest first', async () => {
    const { client, freelancer, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });
    const older = await prisma.review.create({
      data: {
        contractId: contract.id,
        reviewerId: client.id,
        revieweeId: freelancer.id,
        rating: 4,
        content: 'written first',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const newer = await prisma.review.create({
      data: {
        contractId: contract.id,
        reviewerId: freelancer.id,
        revieweeId: client.id,
        rating: 5,
        content: 'written second',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    });

    const res = await authed(freelancer).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews.map((review: { id: string }) => review.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  /**
   * Whether contract responses should expose email addresses is an open product question, so
   * this pins what happens today rather than asserting a decision:
   * `contractInclude` selects `email` for both the client and the freelancer, so either party
   * sees the other's address. Every other endpoint withholds it — the public profile below is the
   * contrast. Deliberate (counterparties to a signed contract) or an oversight is the open
   * question; this test exists so whoever decides it can find the behavior and the blast radius.
   */
  it("returns both parties' email addresses to either party", async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    const clientView = await authed(client).get(`/api/contracts/${contract.id}`);
    const freelancerView = await authed(freelancer).get(`/api/contracts/${contract.id}`);

    expect(clientView.status).toBe(200);
    expect(clientView.body.client.email).toBe(client.email);
    expect(clientView.body.freelancer.email).toBe(freelancer.email);

    expect(freelancerView.status).toBe(200);
    expect(freelancerView.body.client.email).toBe(client.email);
    expect(freelancerView.body.freelancer.email).toBe(freelancer.email);

    // Contrast — the public profile of the same freelancer withholds it (cross-cutting: only
    // `GET /api/users/me` exposes the caller's own email).
    const publicProfile = await api().get(`/api/users/${freelancer.id}`);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.body).not.toHaveProperty('email');
  });
});

describe('POST /api/contracts/:id/sign', () => {
  it("records the client's signature without activating the contract", async () => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: contract.id,
      clientSigned: true,
      freelancerSigned: false,
      status: 'PENDING',
    });
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: true,
      freelancerSigned: false,
      status: 'PENDING',
    });
  });

  it("records the freelancer's signature without activating the contract", async () => {
    const { freelancer, contract } = await makeContractScenario();

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      clientSigned: false,
      freelancerSigned: true,
      status: 'PENDING',
    });
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: false,
      freelancerSigned: true,
      status: 'PENDING',
    });
  });

  it('is idempotent when the same party signs twice', async () => {
    const { client, contract } = await makeContractScenario();

    const first = await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const second = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      clientSigned: true,
      freelancerSigned: false,
      status: 'PENDING',
    });
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: true,
      freelancerSigned: false,
      status: 'PENDING',
    });
  });

  it('activates the contract once both parties have signed', async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    const clientRes = await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const freelancerRes = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(clientRes.body.status).toBe('PENDING');
    expect(freelancerRes.status).toBe(200);
    expect(freelancerRes.body).toMatchObject({
      clientSigned: true,
      freelancerSigned: true,
      status: 'ACTIVE',
    });
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: true,
      freelancerSigned: true,
      status: 'ACTIVE',
    });
  });

  it('activates in either signing order', async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    const clientRes = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(clientRes.status).toBe(200);
    expect(clientRes.body.status).toBe('ACTIVE');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('returns the full contract with its relations on activation', async () => {
    const { client, freelancer, project, contract, milestone } = await makeContractScenario();

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ id: project.id, title: project.title });
    expect(res.body.client).toMatchObject({ id: client.id });
    expect(res.body.freelancer).toMatchObject({ id: freelancer.id });
    expect(res.body).not.toHaveProperty('payment');
    expect(res.body.milestones).toMatchObject([{ id: milestone.id, status: 'PENDING', payment: null }]);
    expect(res.body.milestoneSummary.count).toBe(1);
    expect(res.body.reviews).toEqual([]);
  });

  it('activates exactly once — re-signing an ACTIVE contract leaves it ACTIVE', async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    const again = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      clientSigned: true,
      freelancerSigned: true,
      status: 'ACTIVE',
    });
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses to sign a COMPLETED contract and preserves its status', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'A completed contract cannot be signed again');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('COMPLETED');
  });

  it('refuses to sign a COMPLETED contract for the freelancer too', async () => {
    const { freelancer, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('COMPLETED');
  });

  /**
   * Both parties signing simultaneously must still yield exactly one activation and never a
   * contract stuck at PENDING with both flags set.
   *
   * Why this passes — worth stating, because the obvious reading is wrong. It is **not** the
   * `$transaction` that provides the guarantee: Prisma's default isolation level is READ
   * COMMITTED, under which two concurrent transactions can interleave freely. What serializes
   * the parties is the **row lock Postgres takes on the `UPDATE`**. `prisma.contract.update`
   * compiles to a single `UPDATE … RETURNING`, so the second signer's update blocks until the
   * first signer's transaction commits and then re-reads the committed row — seeing the first
   * signature. Exactly one signer therefore observes both flags set while the status is still
   * PENDING, and only that one activates. A probe of concurrent sign pairs found zero stuck
   * contracts even *before* the transaction was added.
   * The transaction earns its place by closing the crash window between the two statements — see
   * the forced-failure test below, which is the one that actually exercises it.
   *
   * Repeated so a single lucky interleaving cannot make this pass.
   */
  it('serializes concurrent signatures into exactly one activation', async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const { client, freelancer, contract } = await makeContractScenario();

      const [clientRes, freelancerRes] = await Promise.all([
        authed(client).post(`/api/contracts/${contract.id}/sign`),
        authed(freelancer).post(`/api/contracts/${contract.id}/sign`),
      ]);

      expect(clientRes.status, `iteration ${iteration}`).toBe(200);
      expect(freelancerRes.status, `iteration ${iteration}`).toBe(200);

      const activations = [clientRes, freelancerRes]
        .filter((res) => res.body.status === 'ACTIVE').length;
      expect(activations, `iteration ${iteration}: activation responses`).toBe(1);

      const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
      expect(after, `iteration ${iteration}: persisted state`).toMatchObject({
        clientSigned: true,
        freelancerSigned: true,
        status: 'ACTIVE',
      });
    }
  });

  /**
   * Atomicity — the reason `signContract` wraps the signature write and
   * the activation in one transaction. The second party's request performs two
   * `tx.contract.update` calls: the signature, then the activation. Failing the activation must
   * roll the signature back too.
   *
   * The outcome being prevented is a contract with both flags set but still `PENDING` while the
   * caller was told the request failed (500). Nothing then reflects the signatures: the contract
   * is not `ACTIVE`, so `POST /api/payments` refuses it, and neither party has any reason to think
   * a retry is needed. A retry *would* recover it — the activation branch is guarded on `PENDING`,
   * not on the flags — but only if someone happens to sign again. The transaction removes the
   * need to rely on that.
   */
  it('rolls the signature back when the activation step fails', async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    const first = await authed(client).post(`/api/contracts/${contract.id}/sign`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ clientSigned: true, status: 'PENDING' });

    const before = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const injection = failTransactionStep({
      model: 'contract',
      method: 'update',
      call: 2,
      observe: (tx) => tx.contract.findUnique({ where: { id: contract.id } }),
    });

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, INJECTED);
    // Proves the failure landed on the activation and not on the signature write.
    expect(injection.steps).toEqual(['contract.update', 'contract.update']);
    // …and that the signature really was written: inside the transaction, just before the
    // activation failed, both flags were set. So the assertions below observe a rollback, not a
    // write that never happened.
    expect(injection.observed()).toMatchObject({
      clientSigned: true,
      freelancerSigned: true,
      status: 'PENDING',
    });

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: true,
      freelancerSigned: false,
      status: 'PENDING',
    });
    // Whole row, not just the three fields: the signature write left no trace at all.
    expect(after).toEqual(before);

    // And the rolled-back state is still usable: with the injection removed the freelancer's
    // signature succeeds and activates the contract, so nothing was left half-written.
    vi.restoreAllMocks();
    const retry = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      clientSigned: true,
      freelancerSigned: true,
      status: 'ACTIVE',
    });
    const activated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(activated.status).toBe('ACTIVE');
  });

  /**
   * The same email exposure, continued: `POST /:id/sign` returns the same `contractInclude` as
   * `GET /:id`, so it is not confined to one endpoint. Recorded here so a decision on it covers
   * every response shape rather than only the one it was raised about.
   */
  it("exposes both parties' email addresses on the sign response too", async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.client.email).toBe(client.email);
    expect(res.body.freelancer.email).toBe(freelancer.email);
  });

  it('refuses to sign a PENDING contract whose plan does not add up, recording no signature', async () => {
    const { client, contract, milestone } = await makeContractScenario();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { amount: 3_999_999 } });

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Cannot sign a contract without a valid milestone plan');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({ clientSigned: false, freelancerSigned: false, status: 'PENDING' });
  });

  it.each([
    ['no milestones at all', async (contractId: string) => prisma.milestone.deleteMany({ where: { contractId } })],
    ['a milestone that is not PENDING', async (contractId: string) => prisma.milestone.updateMany({ where: { contractId }, data: { status: 'FUNDED' } })],
  ])('refuses to sign with %s', async (_label, corrupt) => {
    const { freelancer, contract } = await makeContractScenario();
    await corrupt(contract.id);

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Cannot sign a contract without a valid milestone plan');
  });

  it('accepts a plan that adds up to the rounded contract amount', async () => {
    const { client, contract } = await makeContractScenario({ contract: { amount: 2_500_000.5 } });
    // The factory's default milestone is Math.round(amount) = 2,500,001.

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.clientSigned).toBe(true);
  });

  it('does not re-check the plan of an ACTIVE contract: re-signing stays idempotent', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED' },
    });

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
  });

  it('notifies each party once with CONTRACT_ACTIVATED on activation', async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    expect(await prisma.notification.count({ where: { type: 'CONTRACT_ACTIVATED' } })).toBe(0);
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`); // idempotent re-sign

    const notifications = await prisma.notification.findMany({ where: { type: 'CONTRACT_ACTIVATED' } });
    expect(notifications.map((n) => n.userId).sort()).toEqual([client.id, freelancer.id].sort());
    for (const n of notifications) expect(n.href).toBe(`/contracts/${contract.id}`);
  });

  it('skips the activation notice for a soft-deleted party', async () => {
    const { client, freelancer, contract } = await makeContractScenario();
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    await authed(client).post(`/api/contracts/${contract.id}/sign`);

    const notifications = await prisma.notification.findMany({ where: { type: 'CONTRACT_ACTIVATED' } });
    expect(notifications.map((n) => n.userId)).toEqual([client.id]);
  });

  it('creates exactly two activation notices when both parties sign concurrently', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const { client, freelancer, contract } = await makeContractScenario();

      await Promise.all([
        authed(client).post(`/api/contracts/${contract.id}/sign`),
        authed(freelancer).post(`/api/contracts/${contract.id}/sign`),
      ]);

      expect(
        await prisma.notification.count({ where: { type: 'CONTRACT_ACTIVATED', href: `/contracts/${contract.id}` } }),
        `iteration ${iteration}`,
      ).toBe(2);
    }
  });
});

describe('POST /api/contracts/:id/sign — system message', () => {
  it('posts CONTRACT_ACTIVATED once, from the activating signature only', async () => {
    const { client, freelancer, contract, conversation } = await makeContractScenario();

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    expect(await systemEvents(conversation.id)).toEqual([]);
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);
    await authed(freelancer).post(`/api/contracts/${contract.id}/sign`); // idempotent re-sign

    expect(await systemEvents(conversation.id)).toEqual(['CONTRACT_ACTIVATED']);
    const [message] = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(message).toMatchObject({ kind: 'SYSTEM', senderId: null });
    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.lastMessageAt?.getTime()).toBe(message.createdAt.getTime());
  });

  it('posts exactly one CONTRACT_ACTIVATED when both parties sign concurrently', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const { client, freelancer, contract, conversation } = await makeContractScenario();

      await Promise.all([
        authed(client).post(`/api/contracts/${contract.id}/sign`),
        authed(freelancer).post(`/api/contracts/${contract.id}/sign`),
      ]);

      expect(await systemEvents(conversation.id), `iteration ${iteration}`).toEqual(['CONTRACT_ACTIVATED']);
    }
  });

  it('posts nothing when the signature is refused', async () => {
    const { client, contract, conversation, milestone } = await makeContractScenario();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { amount: 1 } });

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    expect(await systemEvents(conversation.id)).toEqual([]);
  });

  it('still activates a contract that has no conversation, posting nothing and never failing', async () => {
    const { client, freelancer, contract, conversation } = await makeContractScenario();
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'CONTRACT_ACTIVATED' } })).toBe(2);
  });
});

describe('PATCH /api/contracts/:id', () => {
  const GONE = 'Contracts are completed automatically when every milestone is approved';

  it('is 410 for the client of an ACTIVE, fully paid contract, and writes nothing', async () => {
    const { client, contract, milestone, project } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED' },
    });
    await makePayment(milestone.id, client.id, { status: 'COMPLETED' });

    const res = await authed(client).patch(`/api/contracts/${contract.id}`).send({ status: 'COMPLETED' });

    expect(res.status).toBe(410);
    expectErrorEnvelope(res.body, GONE);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
    const projectAfter = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(projectAfter.status).toBe('CLOSED');
  });

  it.each([
    ['an empty body', {}],
    ['an invalid status', { status: 'BOGUS' }],
  ])('is 410 whatever the body — %s', async (_label, payload) => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).patch(`/api/contracts/${contract.id}`).send(payload);

    expect(res.status).toBe(410);
    expectErrorEnvelope(res.body, GONE);
  });

  it('is 410 for a contract that does not exist and for a third party', async () => {
    const { contract } = await makeContractScenario();
    const outsider = await makeClient();

    const missing = await authed(outsider)
      .patch('/api/contracts/00000000-0000-0000-0000-000000000000')
      .send({ status: 'COMPLETED' });
    const foreign = await authed(outsider).patch(`/api/contracts/${contract.id}`).send({ status: 'COMPLETED' });

    expect([missing.status, foreign.status]).toEqual([410, 410]);
  });

  it('still requires a token: 401 without one', async () => {
    const { contract } = await makeContractScenario();

    const res = await api().patch(`/api/contracts/${contract.id}`).send({ status: 'COMPLETED' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/contracts (list)', () => {
  it("lists the caller's contracts on either side, newest first, with counterpart and summary", async () => {
    const asClient = await makeContractScenario({ contract: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const freelancer = asClient.freelancer;
    const other = await makeContractScenario({ contract: { createdAt: new Date('2026-02-01T00:00:00Z') } });
    // Make the first scenario's freelancer the client side of nothing, and check both views.
    await makeContractScenario(); // unrelated

    const clientView = await authed(asClient.client).get('/api/contracts');
    expect(clientView.status).toBe(200);
    expect(clientView.body.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(clientView.body.contracts).toHaveLength(1);
    expect(clientView.body.contracts[0]).toMatchObject({
      id: asClient.contract.id,
      status: 'PENDING',
      myRole: 'CLIENT',
      project: { id: asClient.project.id, title: asClient.project.title, status: 'CLOSED' },
      counterpart: { id: freelancer.id, name: freelancer.name },
      milestoneSummary: { count: 1, contractAmount: 4_000_000, fundedAmount: 0, approvedAmount: 0, approvedCount: 0 },
    });
    expect(Object.keys(clientView.body.contracts[0].counterpart).sort()).toEqual(['id', 'name', 'profileImage']);
    expect(JSON.stringify(clientView.body)).not.toContain('@');

    const freelancerView = await authed(other.freelancer).get('/api/contracts');
    expect(freelancerView.body.contracts[0]).toMatchObject({
      id: other.contract.id,
      myRole: 'FREELANCER',
      counterpart: { id: other.client.id },
    });
  });

  it('orders newest first and paginates', async () => {
    const first = await makeContractScenario({ contract: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const client = first.client;
    const ids: string[] = [first.contract.id];
    for (const month of [2, 3]) {
      const s = await makeContractScenario({ contract: { createdAt: new Date(`2026-0${month}-01T00:00:00Z`) } });
      await prisma.contract.update({ where: { id: s.contract.id }, data: { clientId: client.id } });
      ids.push(s.contract.id);
    }

    const page1 = await authed(client).get('/api/contracts?limit=2');
    const page2 = await authed(client).get('/api/contracts?limit=2&page=2');

    expect(page1.body.contracts.map((c: { id: string }) => c.id)).toEqual([ids[2], ids[1]]);
    expect(page1.body.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(page2.body.contracts.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
  });

  it('filters by status and caps limit at 50', async () => {
    const pending = await makeContractScenario();
    const active = await makeContractScenario({ contract: { status: 'ACTIVE' } });
    await prisma.contract.update({ where: { id: active.contract.id }, data: { clientId: pending.client.id } });

    const res = await authed(pending.client).get('/api/contracts?status=ACTIVE&limit=500');

    expect(res.status).toBe(200);
    expect(res.body.contracts.map((c: { id: string }) => c.id)).toEqual([active.contract.id]);
    expect(res.body.meta.limit).toBe(50);
  });

  it.each([
    ['an unknown status', '?status=CANCELLED'],
    ['a zero page', '?page=0'],
    ['a negative limit', '?limit=-1'],
    ['a fractional limit', '?limit=1.5'],
    ['trailing garbage', '?page=2abc'],
    ['a repeated parameter', '?limit=1&limit=2'],
    ['a page above 1,000,000', '?page=1000001'],
    ['a page that would overflow skip', '?page=999999999999999999'],
  ])('rejects %s with 400', async (_label, query) => {
    const { client } = await makeContractScenario();

    const res = await authed(client).get(`/api/contracts${query}`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body);
  });

  it('accepts page 1,000,000 (the bound) with an empty page of results', async () => {
    const { client } = await makeContractScenario();

    const res = await authed(client).get('/api/contracts?page=1000000&limit=50');

    expect(res.status).toBe(200);
    expect(res.body.contracts).toEqual([]);
  });

  it('treats empty values as absent', async () => {
    const { client } = await makeContractScenario();

    const res = await authed(client).get('/api/contracts?status=&page=&limit=');

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20 });
  });

  it("leaves out contracts whose project is soft-deleted", async () => {
    const { client, project } = await makeContractScenario();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).get('/api/contracts');

    expect(res.body.contracts).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('carries unreadMessageCount for the caller on each entry', async () => {
    const busy = await makeContractScenario({ contract: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const quiet = await makeContractScenario({
      contract: { clientId: busy.client.id, createdAt: new Date('2026-02-01T00:00:00Z') },
    });
    await makeMessage(busy.conversation.id, busy.freelancer.id);
    await makeMessage(busy.conversation.id, busy.freelancer.id);
    await makeMessage(busy.conversation.id, busy.client.id); // the caller's own
    await makeMessage(busy.conversation.id, null); // system messages never count
    // A contract without a conversation (data repair) counts 0.
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: quiet.conversation.id } });
    await prisma.conversation.delete({ where: { id: quiet.conversation.id } });

    const asClient = await authed(busy.client).get('/api/contracts');
    const asFreelancer = await authed(busy.freelancer).get('/api/contracts');

    expect(asClient.body.contracts.map((c: { id: string; unreadMessageCount: number }) => [c.id, c.unreadMessageCount]))
      .toEqual([[quiet.contract.id, 0], [busy.contract.id, 2]]);
    expect(asFreelancer.body.contracts[0]).toMatchObject({ id: busy.contract.id, unreadMessageCount: 1 });
  });

  it('shows a soft-deleted counterpart as stored', async () => {
    const { client, freelancer } = await makeContractScenario();
    await prisma.user.update({ where: { id: freelancer.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).get('/api/contracts');

    expect(res.body.contracts[0].counterpart).toMatchObject({ id: freelancer.id, name: freelancer.name });
  });
});
