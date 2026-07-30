import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeClient,
  makeContractScenario,
  makeFreelancer,
  makePayment,
} from './helpers/factories';

/**
 * Contracts — `/api/contracts`. Oracle: `docs/BEHAVIOR.md` § Contracts, plus the cross-cutting
 * rules on the error envelope (1), authentication (2), authorization (3) and atomicity (6).
 *
 * No divergences are assigned to this unit: every test asserts intended behavior and is expected
 * to pass. Two tests pin still-undecided behavior instead — `(Q5)` on the project going straight
 * from `CLOSED` to `COMPLETED`, and `(Q9)` on both parties' email addresses being returned.
 */

/** Well-formed but absent id, so a 404 comes from the lookup rather than from id parsing. */
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** Every error body is exactly `{ error: { message } }` — cross-cutting rule 1. */
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
 * Forces one step of an interactive `prisma.$transaction` to reject, so atomicity (cross-cutting
 * rule 6) can be tested for real rather than inferred from the happy path.
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
  it('requires authentication', async () => {
    const { contract } = await makeContractScenario();

    const res = await api().get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'Authentication required');
  });

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

  it('lets the freelancer read the contract', async () => {
    const { freelancer, contract } = await makeContractScenario();

    const res = await authed(freelancer).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(contract.id);
  });

  it('returns 403 for a third party', async () => {
    const { contract } = await makeContractScenario();
    const stranger = await makeClient();

    const res = await authed(stranger).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'Not authorized');
  });

  it('returns 403 for an unrelated freelancer', async () => {
    const { contract } = await makeContractScenario();
    const otherFreelancer = await makeFreelancer();

    const res = await authed(otherFreelancer).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 for a contract that does not exist', async () => {
    const client = await makeClient();

    const res = await authed(client).get(`/api/contracts/${MISSING_ID}`);

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'Contract not found');
  });

  it('includes the project, both parties and the payment', async () => {
    const { client, freelancer, project, contract } = await makeContractScenario();
    const payment = await makePayment(contract.id, client.id, { status: 'COMPLETED' });

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({
      id: project.id,
      title: project.title,
      status: 'CLOSED',
    });
    expect(res.body.client).toMatchObject({ id: client.id, name: client.name });
    expect(res.body.freelancer).toMatchObject({ id: freelancer.id, name: freelancer.name });
    expect(res.body.payment).toMatchObject({ id: payment.id, status: 'COMPLETED' });
  });

  it('reports a null payment when none has been created', async () => {
    const { client, contract } = await makeContractScenario();

    const res = await authed(client).get(`/api/contracts/${contract.id}`);

    expect(res.status).toBe(200);
    expect(res.body.payment).toBeNull();
    expect(res.body.reviews).toEqual([]);
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
   * Q9 is still open, so this pins what happens today rather than asserting a decision:
   * `contractInclude` selects `email` for both the client and the freelancer, so either party
   * sees the other's address. Every other endpoint withholds it — the public profile below is the
   * contrast. Deliberate (counterparties to a signed contract) or an oversight is the open
   * question; this test exists so whoever decides it can find the behavior and the blast radius.
   */
  it("returns both parties' email addresses to either party (Q9)", async () => {
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
  it('requires authentication', async () => {
    const { contract } = await makeContractScenario();

    const res = await api().post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'Authentication required');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.clientSigned).toBe(false);
    expect(after.freelancerSigned).toBe(false);
  });

  it('returns 404 for a contract that does not exist', async () => {
    const client = await makeClient();

    const res = await authed(client).post(`/api/contracts/${MISSING_ID}/sign`);

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'Contract not found');
  });

  it('returns 403 for a third party and records no signature', async () => {
    const { contract } = await makeContractScenario();
    const stranger = await makeClient();

    const res = await authed(stranger).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'Not authorized');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({
      clientSigned: false,
      freelancerSigned: false,
      status: 'PENDING',
    });
  });

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
    const { client, freelancer, project, contract } = await makeContractScenario();

    await authed(client).post(`/api/contracts/${contract.id}/sign`);
    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ id: project.id, title: project.title });
    expect(res.body.client).toMatchObject({ id: client.id });
    expect(res.body.freelancer).toMatchObject({ id: freelancer.id });
    expect(res.body.payment).toBeNull();
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

  it('refuses to sign a COMPLETED contract and preserves its status [D2 fixed]', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });

    const res = await authed(client).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'A completed contract cannot be signed again');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('COMPLETED');
  });

  it('refuses to sign a COMPLETED contract for the freelancer too [D2 fixed]', async () => {
    const { freelancer, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(400);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('COMPLETED');
  });

  it('checks existence before authorization, so a stranger sees 404 not 403', async () => {
    const stranger = await makeFreelancer();

    const res = await authed(stranger).post(`/api/contracts/${MISSING_ID}/sign`);

    expect(res.status).toBe(404);
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
   * PENDING, and only that one activates. See the "Correction on D2" note in BEHAVIOR.md: a probe
   * of concurrent sign pairs found zero stuck contracts even *before* the transaction was added.
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
   * Atomicity (cross-cutting rule 6) — the reason `signContract` wraps the signature write and
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
   * Q9, continued: `POST /:id/sign` returns the same `contractInclude` as `GET /:id`, so the
   * email exposure is not confined to one endpoint. `PATCH /:id` shares it as well. Recorded here
   * so a decision on Q9 covers every response shape rather than only the one it was raised about.
   */
  it("exposes both parties' email addresses on the sign response too (Q9)", async () => {
    const { client, freelancer, contract } = await makeContractScenario();

    const res = await authed(freelancer).post(`/api/contracts/${contract.id}/sign`);

    expect(res.status).toBe(200);
    expect(res.body.client.email).toBe(client.email);
    expect(res.body.freelancer.email).toBe(freelancer.email);
  });
});

describe('PATCH /api/contracts/:id', () => {
  /** An ACTIVE contract with a COMPLETED payment — the only state that may be completed. */
  async function completable() {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    });
    const payment = await makePayment(scenario.contract.id, scenario.client.id, {
      status: 'COMPLETED',
      paymentKey: 'test_payment_key',
    });
    return { ...scenario, payment };
  }

  it('requires authentication', async () => {
    const { contract } = await completable();

    const res = await api().patch(`/api/contracts/${contract.id}`).send({ status: 'COMPLETED' });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'Authentication required');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('returns 400 when status is missing', async () => {
    const { client, contract } = await completable();

    const res = await authed(client).patch(`/api/contracts/${contract.id}`).send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Status must be COMPLETED');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('returns 400 when status is any value other than COMPLETED', async () => {
    const { client, contract } = await completable();

    for (const status of ['ACTIVE', 'PENDING', 'completed', 'CANCELLED', '', null, 1]) {
      const res = await authed(client).patch(`/api/contracts/${contract.id}`).send({ status });

      expect(res.status, `status=${JSON.stringify(status)}`).toBe(400);
      expectErrorEnvelope(res.body, 'Status must be COMPLETED');
    }

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('returns 404 for a contract that does not exist', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .patch(`/api/contracts/${MISSING_ID}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'Contract not found');
  });

  it('returns 403 when the freelancer tries to complete it', async () => {
    const { freelancer, contract, project } = await completable();

    const res = await authed(freelancer)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'Only the client can complete the contract');
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterContract.status).toBe('ACTIVE');
    expect(afterProject.status).toBe('CLOSED');
  });

  it('returns 403 for a third party', async () => {
    const { contract } = await completable();
    const stranger = await makeClient();

    const res = await authed(stranger)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(403);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('checks existence before ownership, so the freelancer sees 404 for a missing contract', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .patch(`/api/contracts/${MISSING_ID}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when the contract is still PENDING', async () => {
    const { client, project, contract } = await makeContractScenario();
    await makePayment(contract.id, client.id, { status: 'COMPLETED' });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Only active contracts can be completed');
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterContract.status).toBe('PENDING');
    expect(afterProject.status).toBe('CLOSED');
  });

  it('returns 400 when the contract is already COMPLETED', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true },
    });
    await makePayment(contract.id, client.id, { status: 'COMPLETED' });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Only active contracts can be completed');
  });

  it('returns 400 when the contract has no payment at all', async () => {
    const { client, project, contract } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Payment must be completed before completing the contract');
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterContract.status).toBe('ACTIVE');
    expect(afterProject.status).toBe('CLOSED');
  });

  it('returns 400 when the payment is still PENDING', async () => {
    const { client, project, contract } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    });
    const payment = await makePayment(contract.id, client.id, { status: 'PENDING' });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Payment must be completed before completing the contract');
    const afterPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterPayment.status).toBe('PENDING');
    expect(afterContract.status).toBe('ACTIVE');
    expect(afterProject.status).toBe('CLOSED');
  });

  it('returns 400 when the payment FAILED', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    });
    await makePayment(contract.id, client.id, { status: 'FAILED' });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Payment must be completed before completing the contract');
  });

  it('returns 400 when the payment was REFUNDED', async () => {
    const { client, contract } = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
    });
    await makePayment(contract.id, client.id, { status: 'REFUNDED' });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'Payment must be completed before completing the contract');
  });

  it('completes the contract and returns it with its relations', async () => {
    const { client, freelancer, project, payment, contract } = await completable();

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: contract.id, status: 'COMPLETED' });
    expect(res.body.project).toMatchObject({ id: project.id, status: 'COMPLETED' });
    expect(res.body.client).toMatchObject({ id: client.id });
    expect(res.body.freelancer).toMatchObject({ id: freelancer.id });
    expect(res.body.payment).toMatchObject({ id: payment.id, status: 'COMPLETED' });
    expect(res.body.reviews).toEqual([]);
  });

  it('sets both the contract and the project to COMPLETED in one transaction', async () => {
    const { client, project, contract } = await completable();

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterContract.status).toBe('COMPLETED');
    expect(afterProject.status).toBe('COMPLETED');
  });

  /**
   * `validTransitions` lists CLOSED as terminal, but that table governs only manual
   * `PATCH /api/projects/:id/status` changes — see the note in BEHAVIOR.md. Completing a
   * contract is a system transition and moves the project straight from CLOSED to COMPLETED.
   * Pinned as current behavior while Q5 (what `IN_PROGRESS` is for) is still open.
   */
  it('moves the project directly from CLOSED to COMPLETED, bypassing validTransitions (Q5)', async () => {
    const { client, project, contract } = await completable();
    expect(project.status).toBe('CLOSED');

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(afterProject.status).toBe('COMPLETED');
    // Q5's proposal would have signing set the project to IN_PROGRESS first; nothing assigns
    // that state today, so the project never passes through it.
    expect(await prisma.project.count({ where: { status: 'IN_PROGRESS' } })).toBe(0);
  });

  it('leaves the application and the payment untouched when completing', async () => {
    const { client, application, payment, contract } = await completable();

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    const afterApplication = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    const afterPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(afterApplication.status).toBe('ACCEPTED');
    expect(afterPayment.status).toBe('COMPLETED');
  });

  /**
   * Atomicity (cross-cutting rule 6) — the transaction sets the project `COMPLETED` and then the
   * contract `COMPLETED`. Failing the contract write must roll the project back.
   *
   * A project reading `COMPLETED` while its contract is still `ACTIVE` is exactly the
   * inconsistency the transaction exists to prevent: the work looks finished to everyone reading
   * the project, but reviews are still refused (`POST /api/reviews` requires a `COMPLETED`
   * contract), and the client cannot walk the project back either, because
   * `PATCH /api/projects/:id/status` treats `COMPLETED` as terminal. Only re-completing the
   * contract would reconcile the two rows, and the caller was told the request failed.
   */
  it('rolls the project back when the contract update fails', async () => {
    const { client, project, contract, payment } = await completable();

    const beforeProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const injection = failTransactionStep({
      model: 'contract',
      method: 'update',
      observe: (tx) => tx.project.findUnique({ where: { id: project.id } }),
    });

    const res = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, INJECTED);
    // The project write ran first and inside the same transaction; the failure landed on the
    // contract update that follows it.
    expect(injection.steps).toEqual(['project.update', 'contract.update']);
    // Read from inside the transaction just before it failed: the project *was* COMPLETED there.
    // That is what makes the CLOSED assertion below evidence of a rollback rather than of a write
    // that never ran.
    expect(injection.observed()).toMatchObject({ status: 'COMPLETED' });

    const afterProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const afterContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const afterPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(afterProject.status).toBe('CLOSED');
    expect(afterContract.status).toBe('ACTIVE');
    expect(afterPayment.status).toBe('COMPLETED');
    // Whole row: the project's `COMPLETED` write was rolled back, not merely overwritten later.
    expect(afterProject).toEqual(beforeProject);

    // Retryable once the failure is removed — both rows move together, as they should have.
    vi.restoreAllMocks();
    const retry = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(retry.status).toBe(200);
    const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const finalContract = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(finalProject.status).toBe('COMPLETED');
    expect(finalContract.status).toBe('COMPLETED');
  });

  it('is not repeatable — a second completion returns 400', async () => {
    const { client, contract } = await completable();

    const first = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });
    const second = await authed(client)
      .patch(`/api/contracts/${contract.id}`)
      .send({ status: 'COMPLETED' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expectErrorEnvelope(second.body, 'Only active contracts can be completed');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe('COMPLETED');
  });
});
