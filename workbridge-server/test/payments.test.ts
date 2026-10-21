import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeApplication,
  makeClient,
  makeContract,
  makeContractScenario,
  makeFreelancer,
  makeMilestone,
  makePayment,
  makeProject,
} from './helpers/factories';

/**
 * TossPayments is mocked at the module boundary. Every test in this file must go through
 * `tossPost`; a real HTTP call to api.tosspayments.com would be a harness failure, so the
 * default implementation below rejects loudly rather than returning something plausible.
 */
const { tossPost, tossGet } = vi.hoisted(() => ({
  tossPost: vi.fn(),
  tossGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: tossPost, get: tossGet },
  post: tossPost,
  get: tossGet,
}));

const CONTRACT_AMOUNT = 4_000_000;

/** The provider's happy-path body for a contract worth `CONTRACT_AMOUNT`. */
const tossDone = (totalAmount: number = CONTRACT_AMOUNT) => ({
  data: { status: 'DONE', totalAmount, paymentKey: 'pk_live_ok', orderId: 'ignored' },
});

beforeEach(() => {
  tossPost.mockReset();
  tossGet.mockReset();
  tossPost.mockRejectedValue(new Error('unexpected TossPayments call'));
});

/**
 * This file is the only one that mutates `ALLOW_PAYMENT_BYPASS`, and `fileParallelism: false`
 * means sibling files can share the worker process — a leaked `'true'` would silently arm the
 * payment bypass for every test that follows. Every mutation below restores the previous value
 * in a `finally`; this asserts that it worked, so a future test that forgets fails here rather
 * than corrupting someone else's file.
 */
afterEach(() => {
  expect(process.env.ALLOW_PAYMENT_BYPASS).toBe('false');
});

/** A client, freelancer, project, accepted application, and a signed **ACTIVE** contract. */
function activeScenario(contract: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
  return makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true, ...contract },
  });
}

/**
 * A second (or third) active contract for an existing pair, with its default milestone. Used
 * where a test needs payments on unrelated contracts.
 */
async function extraActiveContract(client: User, freelancer: User) {
  const project = await makeProject(client.id, { status: 'CLOSED' });
  const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
  const contract = await makeContract(
    {
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    },
    { status: 'ACTIVE' },
  );
  const milestone = await makeMilestone(contract.id, { amount: CONTRACT_AMOUNT });
  return { contract, milestone };
}

/**
 * `completePaymentForDev` reads `ALLOW_PAYMENT_BYPASS` through a function on every request
 * (`isPaymentBypassEnabled`), so flipping `process.env` inside a test is observable. The
 * previous value is always restored, including the "unset" case.
 */
async function withBypassEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.ALLOW_PAYMENT_BYPASS;
  process.env.ALLOW_PAYMENT_BYPASS = 'true';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PAYMENT_BYPASS;
    else process.env.ALLOW_PAYMENT_BYPASS = previous;
  }
}

/**
 * Prisma opens pool connections lazily. On a cold pool the first two "concurrent" requests are
 * handed the *same* connection and therefore serialize end-to-end, which hides every race in
 * this file — a serialized pair of `POST /api/payments` returns a tidy 201/200 and a serialized
 * pair of `POST /confirm` returns a tidy 200/409, i.e. exactly the behavior the D13/D18 tests
 * are supposed to prove is missing. Measured: without this warm-up the create collision
 * reproduced 7 times out of 10; with it, 10 out of 10.
 *
 * Firing a handful of concurrent authenticated reads forces the pool to grow and warms the
 * Express/JWT path, so the requests that follow genuinely overlap.
 */
async function warmConnectionPool(user: User, concurrency = 4) {
  await Promise.all(
    Array.from({ length: concurrency }, () => authed(user).get('/api/payments')),
  );
}

/**
 * Makes the D13 create collision deterministic. A warm pool alone is not enough: the pair still
 * serializes now and then (one request inserts before the other reads), and the `it.fails` pin
 * then passes unexpectedly. Here a separate transaction holds `LOCK TABLE "Payment" IN SHARE
 * MODE`, which lets reads through but blocks every INSERT, while `send` fires the requests. Once
 * `inserters` backends are queued on that lock — so each has already read "no payment yet" — the
 * lock is released and the inserts collide on the unique `milestoneId`.
 *
 * If fewer than `inserters` ever queue (a fix that serializes the pair before the insert), the
 * lock is released after `maxWaitMs` anyway and the requests finish on their own.
 */
async function collideOnPaymentInsert<T>(
  inserters: number,
  send: () => Promise<T>,
  maxWaitMs = 3_000,
): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });

  const holder = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`LOCK TABLE "Payment" IN SHARE MODE`;
    signalLocked();
    await released;
  }, { timeout: maxWaitMs + 5_000 });

  try {
    await locked;
    const pending = send();
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks
         WHERE locktype = 'relation' AND relation = '"Payment"'::regclass AND NOT granted`;
      if (waiting >= inserters) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await holder;
    return await pending;
  } finally {
    release();
  }
}

/**
 * Markers that must never appear in an error body — see [D14]. Matched by *shape* rather than
 * by the exact text, so the tests survive a Prisma version bump or a controller edit that moves
 * the offending line: the file:line pattern is `\.ts:\d+:\d+`, not `payments.controller.ts:70:42`.
 */
const INTERNALS_MARKERS: Array<[label: string, pattern: RegExp]> = [
  ['an absolute filesystem path', /\/Users\//],
  // Portable stand-in for the above — the home directory differs off macOS, the repo name does not.
  ['an absolute path into the repository', /\/workbridge-server\//],
  ['a server source directory', /src\/controllers/],
  ['a source file and line reference', /\.ts:\d+:\d+/],
  ['a source excerpt', /→\s*\d+/],
  ['a Prisma client invocation', /prisma\.\w+\.\w+\(\)/],
  ['a database constraint detail', /[Uu]nique constraint failed/],
  ['a raw column reference', /`(contractId|milestoneId)`/],
  ['a SQL statement', /\b(SELECT\s|INSERT\s+INTO\s|UPDATE\s+"|DELETE\s+FROM\s)/],
];

function assertNoInternalsLeak(message: unknown) {
  const text = String(message);
  for (const [label, pattern] of INTERNALS_MARKERS) {
    expect(text, `error body exposes ${label}: ${text}`).not.toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// POST /api/payments — create or resume a payment intent
// ---------------------------------------------------------------------------

describe('POST /api/payments', () => {
  it('rejects a missing milestoneId with 400 and writes nothing [PY1] [C1]', async () => {
    const { client } = await activeScenario();

    const res = await authed(client).post('/api/payments').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Milestone ID is required' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('ignores a contractId: a body with only contractId is the same 400 [PY1] [C1]', async () => {
    const { client, contract } = await activeScenario();

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Milestone ID is required' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 404 for a milestone that does not exist [PY1]', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/payments')
      .send({ milestoneId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Milestone not found' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("returns 404 when the milestone's project is soft-deleted [PY1]", async () => {
    const { client, project, milestone } = await activeScenario();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Milestone not found' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("returns 403 when the caller is the contract's freelancer, not the paying client [PY1]", async () => {
    const { freelancer, milestone } = await activeScenario();

    const res = await authed(freelancer).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 403 for an unrelated client [PY1]', async () => {
    const { milestone } = await activeScenario();
    const outsider = await makeClient();

    const res = await authed(outsider).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Not authorized');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 400 for a PENDING (unsigned) contract [PY1]', async () => {
    const { client, contract, milestone } = await makeContractScenario();
    expect(contract.status).toBe('PENDING');

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 400 for a COMPLETED contract [PY1]', async () => {
    const { client, milestone } = await activeScenario({ status: 'COMPLETED' });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('refuses a milestone while an earlier one is still PENDING [PY1] [M13]', async () => {
    const { client, contract } = await activeScenario();
    const second = await makeMilestone(contract.id, { amount: 1_000_000 });

    const res = await authed(client).post('/api/payments').send({ milestoneId: second.id });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Earlier milestones must be funded first' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('allows the next milestone once every earlier one is funded [M13]', async () => {
    const { client, contract, milestone } = await activeScenario();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED' } });
    const second = await makeMilestone(contract.id, { amount: 1_000_000 });

    const res = await authed(client).post('/api/payments').send({ milestoneId: second.id });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1_000_000);
  });

  it('checks the order before the funded state: an earlier PENDING milestone wins over 409 [PY1]', async () => {
    const { client, contract } = await activeScenario();
    const second = await makeMilestone(contract.id, { amount: 1_000_000, status: 'FUNDED' });

    const res = await authed(client).post('/api/payments').send({ milestoneId: second.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Earlier milestones must be funded first');
  });

  it('returns 409 Milestone is already funded for a funded milestone, leaving its payment untouched [PY1] [C1]', async () => {
    const { client, milestone } = await activeScenario();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED' } });
    const completed = await makePayment(milestone.id, client.id, {
      status: 'COMPLETED',
      paymentKey: 'pk_settled',
    });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Milestone is already funded' } });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', orderId: completed.orderId, paymentKey: 'pk_settled' });
    expect(await prisma.payment.count()).toBe(1);
  });

  it('creates a PENDING payment with a fresh orderId and 201 when none exists [PY2] [PY3] [PY4]', async () => {
    const { client, contract, milestone } = await activeScenario();

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      orderId: expect.any(String),
      amount: CONTRACT_AMOUNT,
      paymentId: expect.any(String),
    });

    const payments = await prisma.payment.findMany();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: res.body.paymentId,
      orderId: res.body.orderId,
      contractId: contract.id,
      milestoneId: milestone.id,
      clientId: client.id,
      amount: CONTRACT_AMOUNT,
      status: 'PENDING',
      paymentKey: null,
    });
  });

  it('takes the amount from the milestone, not the contract or the request body [PY3] [C1]', async () => {
    const { client, contract, milestone } = await activeScenario();
    await prisma.milestone.update({ where: { id: milestone.id }, data: { amount: 1_500_000 } });
    await makeMilestone(contract.id, { amount: 2_500_000 });

    const res = await authed(client)
      .post('/api/payments')
      .send({ milestoneId: milestone.id, amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1_500_000);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { milestoneId: milestone.id } });
    expect(payment.amount).toBe(1_500_000);
  });

  it('resumes an existing PENDING payment: same orderId, 200, no second row [PY2]', async () => {
    const { client, milestone } = await activeScenario();
    const existing = await makePayment(milestone.id, client.id, { status: 'PENDING' });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orderId: existing.orderId,
      amount: existing.amount,
      paymentId: existing.id,
    });
    expect(await prisma.payment.count()).toBe(1);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.orderId).toBe(existing.orderId);
    expect(after.status).toBe('PENDING');
  });

  it('retries a FAILED payment: resets to PENDING with a new orderId and cleared paymentKey [PY2]', async () => {
    const { client, milestone } = await activeScenario();
    const failed = await makePayment(milestone.id, client.id, {
      status: 'FAILED',
      paymentKey: 'pk_from_failed_attempt',
      amount: 1, // must be re-derived from the milestone on retry
    });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(200);
    expect(res.body.paymentId).toBe(failed.id);
    expect(res.body.orderId).not.toBe(failed.orderId);
    expect(res.body.amount).toBe(CONTRACT_AMOUNT);

    expect(await prisma.payment.count()).toBe(1);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: failed.id } });
    expect(after).toMatchObject({
      status: 'PENDING',
      paymentKey: null,
      amount: CONTRACT_AMOUNT,
      orderId: res.body.orderId,
    });
    expect(after.orderId).not.toBe(failed.orderId);
  });

  it('returns 409 for a COMPLETED payment on a still-PENDING milestone (inconsistent state) [PY2]', async () => {
    const { client, milestone } = await activeScenario();
    const completed = await makePayment(milestone.id, client.id, {
      status: 'COMPLETED',
      paymentKey: 'pk_settled',
    });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { message: 'Payment already completed for this milestone' },
    });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', orderId: completed.orderId, paymentKey: 'pk_settled' });
    expect(await prisma.payment.count()).toBe(1);
  });

  it('returns 409 when the payment is REFUNDED, leaving it untouched [PY2]', async () => {
    const { client, milestone } = await activeScenario();
    const refunded = await makePayment(milestone.id, client.id, {
      status: 'REFUNDED',
      paymentKey: 'pk_refunded',
    });

    const res = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Payment cannot be created for this milestone' } });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: refunded.id } });
    expect(after).toMatchObject({ status: 'REFUNDED', orderId: refunded.orderId });
    expect(await prisma.payment.count()).toBe(1);
  });

  // [D13] `Payment.milestoneId` is unique and `createPayment` never catches P2002, so when two
  // requests both read "no payment yet" the loser's `prisma.payment.create` rejects and reaches
  // `errorHandler` without a `statusCode`.
  //
  // Verified: one **201** and one **500**. Cross-cutting rule 8 requires a unique-constraint
  // collision to be a **409** — the same defect class as D4, which was fixed for
  // `Contract.projectId` but never for the money path. Either request may legitimately win, so
  // the assertion is on the set of acceptable statuses (create → 201, resume → 200,
  // collision → 409) rather than on which one each request got.
  it.fails(
    'never returns 5xx when two concurrent creates collide on the unique milestoneId [D13]',
    async () => {
      const { client, milestone } = await activeScenario();
      await warmConnectionPool(client);
      // The 500 is logged by `errorHandler`; silence it so the intended failure is readable.
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        // Both requests read "no payment" before either inserts, every run (see the helper).
        const responses = await collideOnPaymentInsert(2, () => Promise.all([
          authed(client).post('/api/payments').send({ milestoneId: milestone.id }),
          authed(client).post('/api/payments').send({ milestoneId: milestone.id }),
        ]));

        for (const res of responses) {
          expect([200, 201, 409]).toContain(res.status);
        }
        // This half already holds — the database, not the controller, is what keeps the
        // second row out. It is asserted so that a future 409 fix cannot be implemented by
        // letting both writes through.
        expect(await prisma.payment.count()).toBe(1);
      } finally {
        logs.mockRestore();
      }
    },
  );

  // [D14] `errorHandler` renders `err.message` verbatim, and Prisma formats its errors with the
  // **absolute source path**, a source excerpt and the offending argument. A non-string
  // `milestoneId` survives `!milestoneId` and makes Prisma reject the milestone lookup.
  //
  // Deliberately status-agnostic: rule 8 says a malformed value should be a 400 rather than a
  // 500, but *no* status may expose internals, so fixing either defect independently still
  // leaves this test meaningful.
  it.fails(
    'does not expose file paths or source excerpts when Prisma rejects a malformed milestoneId [D14]',
    async () => {
      const { client } = await activeScenario();
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const res = await authed(client).post('/api/payments').send({ milestoneId: 12345 });

        expect(res.body).toHaveProperty('error.message');
        assertNoInternalsLeak(res.body.error.message);
      } finally {
        logs.mockRestore();
      }
    },
  );

  // [D14] The same leak on the money path specifically: the D13 collision's 500 body carries
  // `Invalid \`prisma.payment.create()\` invocation in /Users/…/src/controllers/
  // payments.controller.ts:…`, the surrounding source lines, and
  // ``Unique constraint failed on the fields: (`milestoneId`)`` — i.e. the schema's column name.
  //
  // Several rounds are run because the collision is a real race and a serialized pair produces
  // no 500 at all. The assertion itself never requires a 500 to have happened: it is the
  // invariant "no error body leaks internals", checked over every response.
  it.fails('does not leak Prisma internals in the 500 body from a create collision [D14]', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const milestones = [
      (await extraActiveContract(client, freelancer)).milestone,
      (await extraActiveContract(client, freelancer)).milestone,
      (await extraActiveContract(client, freelancer)).milestone,
    ];
    await warmConnectionPool(client);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const milestone of milestones) {
        const responses = await collideOnPaymentInsert(2, () => Promise.all([
          authed(client).post('/api/payments').send({ milestoneId: milestone.id }),
          authed(client).post('/api/payments').send({ milestoneId: milestone.id }),
        ]));

        for (const res of responses) {
          if (res.body?.error) assertNoInternalsLeak(res.body.error.message);
        }
      }
    } finally {
      logs.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/payments/confirm — verify with TossPayments
// ---------------------------------------------------------------------------

describe('POST /api/payments/confirm', () => {
  /** An ACTIVE contract with a PENDING payment ready to be confirmed. */
  async function pendingPayment(amount: number = CONTRACT_AMOUNT) {
    const scenario = await activeScenario({ amount });
    const payment = await makePayment(scenario.milestone.id, scenario.client.id, {
      status: 'PENDING',
      amount,
    });
    return { ...scenario, payment };
  }

  const body = (orderId: string, amount: number | string) => ({
    paymentKey: 'pk_test_123',
    orderId,
    amount,
  });

  it.each([
    ['paymentKey', { orderId: 'o', amount: 1000 }],
    ['orderId', { paymentKey: 'pk', amount: 1000 }],
    ['amount', { paymentKey: 'pk', orderId: 'o' }],
  ])('rejects a missing %s with 400 and never calls the provider', async (_field, payload) => {
    const { client, payment } = await pendingPayment();

    const res = await authed(client).post('/api/payments/confirm').send(payload);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'paymentKey, orderId, and amount are required' },
    });
    expect(tossPost).not.toHaveBeenCalled();

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('PENDING');
  });

  /**
   * `amount: 0` is **falsy**, so `!amount` catches it and the "positive finite number" rule
   * below is never reached. The message is the load-bearing part of this test: without it the
   * test name would imply the positivity check while actually exercising the required-field
   * guard, and it would keep passing even if the positivity check were deleted. The case that
   * genuinely reaches the positivity rule is the table immediately after.
   */
  it('rejects amount 0 with 400 from the required-field guard, not the positivity check', async () => {
    const { client, payment } = await pendingPayment();

    const res = await authed(client).post('/api/payments/confirm').send(body(payment.orderId, 0));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'paymentKey, orderId, and amount are required' },
    });
    expect(tossPost).not.toHaveBeenCalled();
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('PENDING');
  });

  it.each([
    ['a non-numeric string', 'abc'],
    ['a negative number', -100],
    ['-1', -1],
    // Truthy but numerically zero, so unlike `0` it survives `!amount` and is the value that
    // actually proves the `requestedAmount <= 0` branch exists.
    ["the string '0'", '0'],
    ["the string '-0.0'", '-0.0'],
    // Truthy and parses, but is not finite — proves the `Number.isFinite` half of the rule.
    ['a non-finite value', 'Infinity'],
  ])('rejects %s amount with 400 Invalid payment amount', async (_label, amount) => {
    const { client, payment } = await pendingPayment();

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, amount));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Invalid payment amount' } });
    expect(tossPost).not.toHaveBeenCalled();

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('PENDING');
  });

  it('returns 404 for an unknown orderId', async () => {
    const { client } = await pendingPayment();

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body('order-does-not-exist', CONTRACT_AMOUNT));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Payment not found' } });
    expect(tossPost).not.toHaveBeenCalled();
  });

  it("returns 403 for another user's payment and leaves it PENDING", async () => {
    const { payment } = await pendingPayment();
    const outsider = await makeClient();

    const res = await authed(outsider)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });
    expect(tossPost).not.toHaveBeenCalled();

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('PENDING');
  });

  it("returns 403 when the contract's freelancer tries to confirm", async () => {
    const { freelancer, payment } = await pendingPayment();

    const res = await authed(freelancer)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(403);
    expect(tossPost).not.toHaveBeenCalled();
  });

  it('returns 409 for an already COMPLETED payment, so confirmation is not replayable', async () => {
    const { client, milestone } = await activeScenario();
    const payment = await makePayment(milestone.id, client.id, {
      status: 'COMPLETED',
      paymentKey: 'pk_original',
    });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Payment has already been processed' } });
    expect(tossPost).not.toHaveBeenCalled();

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', paymentKey: 'pk_original' });
  });

  it('returns 409 for a FAILED payment (it must be re-created via POST / first)', async () => {
    const { client, milestone } = await activeScenario();
    const payment = await makePayment(milestone.id, client.id, { status: 'FAILED' });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Payment has already been processed');
    expect(tossPost).not.toHaveBeenCalled();

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('FAILED');
  });

  it('returns 409 for a REFUNDED payment', async () => {
    const { client, milestone } = await activeScenario();
    const payment = await makePayment(milestone.id, client.id, { status: 'REFUNDED' });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(409);
    expect(tossPost).not.toHaveBeenCalled();
  });

  it('refuses to underpay: a submitted amount below the stored amount is 400', async () => {
    const { client, payment } = await pendingPayment();

    const res = await authed(client).post('/api/payments/confirm').send(body(payment.orderId, 1_000));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'Payment amount does not match the contract amount' },
    });
    expect(tossPost).not.toHaveBeenCalled();

    // The mismatch is rejected before the provider is involved, so the intent stays
    // resumable rather than being burned to FAILED.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toMatchObject({ status: 'PENDING', amount: CONTRACT_AMOUNT, paymentKey: null });
  });

  it('rejects a submitted amount above the stored amount with 400', async () => {
    const { client, payment } = await pendingPayment();

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT + 1));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Payment amount does not match the contract amount');
    expect(tossPost).not.toHaveBeenCalled();
  });

  it('completes the payment and stores the paymentKey on success', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: payment.id,
      orderId: payment.orderId,
      status: 'COMPLETED',
      paymentKey: 'pk_test_123',
      amount: CONTRACT_AMOUNT,
    });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', paymentKey: 'pk_test_123' });
  });

  it('calls TossPayments once with the confirm payload and basic-auth credentials', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());

    await authed(client).post('/api/payments/confirm').send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(tossPost).toHaveBeenCalledTimes(1);
    const [url, payload, config] = tossPost.mock.calls[0] as [string, unknown, any];
    expect(url).toBe('https://api.tosspayments.com/v1/payments/confirm');
    expect(payload).toEqual({
      paymentKey: 'pk_test_123',
      orderId: payment.orderId,
      amount: CONTRACT_AMOUNT,
    });
    expect(config.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString('base64')}`,
    );
    expect(config.headers['Content-Type']).toBe('application/json');
  });

  it('accepts a numeric string amount and forwards it to the provider as a number', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, String(CONTRACT_AMOUNT)));

    expect(res.status).toBe(200);
    const [, payload] = tossPost.mock.calls[0] as [string, { amount: unknown }];
    expect(payload.amount).toBe(CONTRACT_AMOUNT);
  });

  it("marks the payment FAILED and returns 400 when the provider status is not 'DONE'", async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue({ data: { status: 'CANCELED', totalAmount: CONTRACT_AMOUNT } });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Payment verification failed' } });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toMatchObject({ status: 'FAILED', paymentKey: null });
  });

  it("marks the payment FAILED and returns 400 when the provider's totalAmount differs", async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone(CONTRACT_AMOUNT - 1));

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Payment verification failed');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('FAILED');
  });

  it('marks the payment FAILED and returns 400 when the provider request rejects', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockRejectedValue(new Error('socket hang up'));

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Payment verification failed' } });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('FAILED');
  });

  it('never returns 500 for a malformed provider body — 400 and FAILED instead', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue({ data: null });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Payment verification failed');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('FAILED');
  });

  it('a FAILED confirmation can be retried after POST / mints a new orderId', async () => {
    const { client, milestone, payment } = await pendingPayment();
    tossPost.mockRejectedValue(new Error('gateway timeout'));

    await authed(client).post('/api/payments/confirm').send(body(payment.orderId, CONTRACT_AMOUNT));

    const resume = await authed(client).post('/api/payments').send({ milestoneId: milestone.id });
    expect(resume.status).toBe(200);
    expect(resume.body.orderId).not.toBe(payment.orderId);

    tossPost.mockReset();
    tossPost.mockResolvedValue(tossDone());
    const second = await authed(client)
      .post('/api/payments/confirm')
      .send(body(resume.body.orderId, CONTRACT_AMOUNT));

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('COMPLETED');
    expect(await prisma.payment.count()).toBe(1);
  });

  // [D8] `catch (tossError)` discards its argument and nothing is logged, so a network fault
  // and a provider-reported amount mismatch produce byte-identical output: 400
  // 'Payment verification failed' with the payment FAILED. Nothing reaches console.error
  // because errorHandler only logs status 500.
  it.fails('logs the underlying provider failure cause [D8]', async () => {
    const { client, payment } = await pendingPayment();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tossPost.mockRejectedValue(new Error('TOSS_FAULT_MARKER: ECONNRESET'));

    try {
      const res = await authed(client)
        .post('/api/payments/confirm')
        .send(body(payment.orderId, CONTRACT_AMOUNT));
      expect(res.status).toBe(400);

      const logged = spy.mock.calls.flat().map((arg) => String(arg)).join(' | ');
      expect(logged).toContain('TOSS_FAULT_MARKER');
    } finally {
      spy.mockRestore();
    }
  });

  // [D18] The replay guard is `if (payment.status !== 'PENDING') throw 409` — a read, then a
  // separate unlocked `update`. Nothing serializes the two, so two concurrent confirms both read
  // `PENDING`, both pass the guard, both call TossPayments, and both write `COMPLETED`.
  //
  // Verified today: **two 200s** and the provider called **twice** — a double capture against
  // the same order. The row count stays 1 only because both updates target the same row, so
  // persisted state alone does not reveal the bug; the provider call count is the real evidence.
  it.fails(
    'confirms exactly once when two requests race the same PENDING payment [D18]',
    async () => {
      const { client, payment } = await pendingPayment();
      tossPost.mockResolvedValue(tossDone());
      // Without this the pair serializes on a single pool connection and the guard *appears*
      // to work: 200 then 409, provider once. See `warmConnectionPool`.
      await warmConnectionPool(client);

      const payload = body(payment.orderId, CONTRACT_AMOUNT);
      const responses = await Promise.all([
        authed(client).post('/api/payments/confirm').send(payload),
        authed(client).post('/api/payments/confirm').send(payload),
      ]);

      // Exactly one winner; the loser must be told the payment was already processed. This is
      // the assertion that trips today — it sees `[200, 200]`.
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);

      // The independently damning half, measured separately: `tossPost` is called twice today,
      // i.e. the order is confirmed against the provider twice.
      expect(tossPost).toHaveBeenCalledTimes(1);

      expect(await prisma.payment.count({ where: { status: 'COMPLETED' } })).toBe(1);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after).toMatchObject({ status: 'COMPLETED', paymentKey: 'pk_test_123' });
    },
  );

  it("returns 404 before any provider call when the payment's project is soft-deleted [PY5] [C1]", async () => {
    const { client, project, payment } = await pendingPayment();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Payment not found' } });
    expect(tossPost).not.toHaveBeenCalled();
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('PENDING');
  });

  it('funds the milestone in the same transaction: FUNDED, notification, due-date jobs [PY6] [PY7] [C1]', async () => {
    const { client, freelancer, milestone, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: payment.id, status: 'COMPLETED' });

    const after = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(after.status).toBe('FUNDED');
    expect(after.fundedAt).not.toBeNull();

    const notifications = await prisma.notification.findMany({ where: { type: 'MILESTONE_FUNDED' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: freelancer.id,
      href: `/contracts/${milestone.contractId}/milestones/${milestone.id}`,
    });

    // The freelancer's MILESTONE_FUNDED email job is asserted in email.test.ts (NC9).
    const jobs = await prisma.job.findMany({ where: { type: { not: 'notification.email' } }, orderBy: { runAt: 'asc' } });
    expect(jobs.map((j) => j.type)).toEqual(['milestone.dueSoon', 'milestone.overdue']);
    expect(jobs[0].runAt.getTime()).toBe(milestone.dueDate.getTime() - 24 * 3600_000);
    expect(jobs[1].runAt.getTime()).toBe(milestone.dueDate.getTime());
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      `milestone.dueSoon:${milestone.id}`,
      `milestone.overdue:${milestone.id}`,
    ]);
  });

  it('skips the due-soon job when that moment has already passed [PY7] [M16]', async () => {
    const { client, milestone, payment } = await pendingPayment();
    await prisma.milestone.update({
      where: { id: milestone.id },
      data: { dueDate: new Date(Date.now() + 3600_000) },
    });
    tossPost.mockResolvedValue(tossDone());

    const res = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(200);
    const jobs = await prisma.job.findMany({ where: { type: { not: 'notification.email' } } });
    expect(jobs.map((j) => j.type)).toEqual(['milestone.overdue']);
  });

  /**
   * PY9, variant 1: the provider accepts both calls (D18 lets both through). The second
   * funding step finds the milestone FUNDED and is a no-op instead of throwing — which the
   * catch-all would otherwise turn into a FAILED payment.
   */
  it('two concurrent confirms leave one COMPLETED payment, one FUNDED milestone, one notification [PY9] [PY7]', async () => {
    const { client, milestone, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());
    await warmConnectionPool(client);

    const payload = body(payment.orderId, CONTRACT_AMOUNT);
    await Promise.all([
      authed(client).post('/api/payments/confirm').send(payload),
      authed(client).post('/api/payments/confirm').send(payload),
    ]);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('COMPLETED');
    const milestoneAfter = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(milestoneAfter.status).toBe('FUNDED');
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_FUNDED' } })).toBe(1);
    expect(await prisma.job.count({ where: { type: 'milestone.dueSoon' } })).toBe(1);
    expect(await prisma.job.count({ where: { type: 'milestone.overdue' } })).toBe(1);
  });

  /**
   * PY9, variant 2: the real provider rejects the second confirmation of one payment. The
   * loser's FAILED write is conditional on PENDING (PY8), so it cannot overwrite the winner.
   */
  it('a losing confirm whose provider call rejects never turns the COMPLETED payment FAILED [PY9] [PY8]', async () => {
    const { client, milestone, payment } = await pendingPayment();
    let calls = 0;
    tossPost.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return tossDone();
      throw new Error('ALREADY_PROCESSED_PAYMENT');
    });
    await warmConnectionPool(client);

    const payload = body(payment.orderId, CONTRACT_AMOUNT);
    const responses = await Promise.all([
      authed(client).post('/api/payments/confirm').send(payload),
      authed(client).post('/api/payments/confirm').send(payload),
    ]);

    expect(responses.map((r) => r.status)).toContain(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('COMPLETED');
    const milestoneAfter = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(milestoneAfter.status).toBe('FUNDED');
    expect(await prisma.notification.count({ where: { type: 'MILESTONE_FUNDED' } })).toBe(1);
  });

  it('the FAILED write is conditional on PENDING: a sequential late failure leaves COMPLETED alone [PY8]', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());
    const first = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));
    expect(first.status).toBe(200);

    // A replay is stopped by the 409 guard before the provider; the payment stays COMPLETED.
    const replay = await authed(client)
      .post('/api/payments/confirm')
      .send(body(payment.orderId, CONTRACT_AMOUNT));
    expect(replay.status).toBe(409);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('COMPLETED');
  });

  // Deterministic version of the race above: the "winner" commits COMPLETED while this confirm's
  // provider call is in flight, then the provider rejects. Fails if the FAILED write is unconditional.
  it('a provider rejection after a concurrent winner committed leaves COMPLETED and answers 400 [PY8]', async () => {
    const { client, payment } = await pendingPayment();
    tossPost.mockImplementation(async () => {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'COMPLETED', paymentKey: 'pk_winner' } });
      throw new Error('ALREADY_PROCESSED_PAYMENT');
    });

    const res = await authed(client).post('/api/payments/confirm').send(body(payment.orderId, CONTRACT_AMOUNT));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Payment verification failed');
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: 'COMPLETED', paymentKey: 'pk_winner' });
  });

  it('a database failure after capture marks the payment FAILED and answers 400 [PY8]', async () => {
    const { client, milestone, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());
    // Make the funding step's notification insert fail with a temporary CHECK constraint.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Notification" ADD CONSTRAINT "tmp_no_funded" CHECK ("type" <> 'MILESTONE_FUNDED')`,
    );
    try {
      const res = await authed(client)
        .post('/api/payments/confirm')
        .send(body(payment.orderId, CONTRACT_AMOUNT));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Payment verification failed' } });
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('FAILED');
      const milestoneAfter = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(milestoneAfter.status).toBe('PENDING');
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Notification" DROP CONSTRAINT "tmp_no_funded"`);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/payments/dev-complete — local/demo bypass
// ---------------------------------------------------------------------------

describe('POST /api/payments/dev-complete', () => {
  describe('when the bypass is disabled', () => {
    it("returns 403 with ALLOW_PAYMENT_BYPASS='false' and writes nothing [PY10]", async () => {
      const { client, milestone } = await activeScenario();

      const res = await authed(client)
        .post('/api/payments/dev-complete')
        .send({ milestoneId: milestone.id });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: 'Payment bypass is disabled' } });
      expect(await prisma.payment.count()).toBe(0);
      const after = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(after.status).toBe('PENDING');
    });

    it('returns 403 when ALLOW_PAYMENT_BYPASS is unset', async () => {
      const previous = process.env.ALLOW_PAYMENT_BYPASS;
      delete process.env.ALLOW_PAYMENT_BYPASS;
      try {
        const { client, milestone } = await activeScenario();

        const res = await authed(client)
          .post('/api/payments/dev-complete')
          .send({ milestoneId: milestone.id });

        expect(res.status).toBe(403);
        expect(res.body.error.message).toBe('Payment bypass is disabled');
        expect(await prisma.payment.count()).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.ALLOW_PAYMENT_BYPASS;
        else process.env.ALLOW_PAYMENT_BYPASS = previous;
      }
    });

    it("returns 403 for a value that is merely truthy, like '1'", async () => {
      const previous = process.env.ALLOW_PAYMENT_BYPASS;
      process.env.ALLOW_PAYMENT_BYPASS = '1';
      try {
        const { client, milestone } = await activeScenario();

        const res = await authed(client)
          .post('/api/payments/dev-complete')
          .send({ milestoneId: milestone.id });

        expect(res.status).toBe(403);
        expect(await prisma.payment.count()).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.ALLOW_PAYMENT_BYPASS;
        else process.env.ALLOW_PAYMENT_BYPASS = previous;
      }
    });

    it('is checked before anything else — a missing milestoneId still returns 403, not 400 [PY10]', async () => {
      const { client } = await activeScenario();

      const res = await authed(client).post('/api/payments/dev-complete').send({});

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Payment bypass is disabled');
    });

    it('leaves a completed payment path unreachable: an existing PENDING payment is untouched', async () => {
      const { client, milestone } = await activeScenario();
      const payment = await makePayment(milestone.id, client.id, { status: 'PENDING' });

      await authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id });

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after).toMatchObject({ status: 'PENDING', paymentKey: null });
    });
  });

  describe('when the bypass is enabled', () => {
    it('rejects a missing milestoneId with 400 [PY10]', async () => {
      const { client } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({}),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Milestone ID is required' } });
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 404 for a milestone that does not exist [PY10]', async () => {
      const client = await makeClient();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: 'nope' }),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Milestone not found');
    });

    it("returns 404 when the milestone's project is soft-deleted [PY10]", async () => {
      const { client, project, milestone } = await activeScenario();
      await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(404);
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 403 for the freelancer on the contract [PY10]', async () => {
      const { freelancer, milestone } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(freelancer).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Not authorized');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 403 for an unrelated client', async () => {
      const { milestone } = await activeScenario();
      const outsider = await makeClient();

      const res = await withBypassEnabled(() =>
        authed(outsider).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(403);
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 400 for a contract that is not ACTIVE [PY10]', async () => {
      const { client, milestone } = await makeContractScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('refuses a milestone while an earlier one is still PENDING [PY10] [M13]', async () => {
      const { client, contract } = await activeScenario();
      const second = await makeMilestone(contract.id, { amount: 1_000_000 });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: second.id }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Earlier milestones must be funded first');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('creates a COMPLETED payment with paymentKey dev_bypass_<milestoneId>, 201, and funds the milestone [PY11] [C1]', async () => {
      const { client, freelancer, contract, milestone } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        contractId: contract.id,
        milestoneId: milestone.id,
        clientId: client.id,
        amount: CONTRACT_AMOUNT,
        status: 'COMPLETED',
        paymentKey: `dev_bypass_${milestone.id}`,
      });
      expect(res.body.orderId).toMatch(/^dev-/);

      const after = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(after.status).toBe('FUNDED');
      expect(after.fundedAt).not.toBeNull();
      expect(await prisma.notification.count({ where: { userId: freelancer.id, type: 'MILESTONE_FUNDED' } })).toBe(1);
      expect(await prisma.job.count({ where: { type: 'milestone.overdue' } })).toBe(1);
    });

    it('completes an existing PENDING payment in place, keeping its orderId and row [PY11]', async () => {
      const { client, milestone } = await activeScenario();
      const pending = await makePayment(milestone.id, client.id, {
        status: 'PENDING',
        amount: 1, // re-derived from the milestone
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(200);
      expect(await prisma.payment.count()).toBe(1);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: pending.id } });
      expect(after).toMatchObject({
        orderId: pending.orderId,
        status: 'COMPLETED',
        amount: CONTRACT_AMOUNT,
        paymentKey: `dev_bypass_${milestone.id}`,
      });
    });

    it('completes an existing FAILED payment in place [PY11]', async () => {
      const { client, milestone } = await activeScenario();
      const failed = await makePayment(milestone.id, client.id, {
        status: 'FAILED',
        paymentKey: 'pk_failed',
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(200);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: failed.id } });
      expect(after).toMatchObject({ status: 'COMPLETED', paymentKey: `dev_bypass_${milestone.id}` });
    });

    it('is idempotent: a funded milestone with a COMPLETED payment is returned unchanged [PY10]', async () => {
      const { client, milestone } = await activeScenario();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED' } });
      const completed = await makePayment(milestone.id, client.id, {
        status: 'COMPLETED',
        paymentKey: 'pk_real_capture',
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: completed.id, paymentKey: 'pk_real_capture' });
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
      expect(after.paymentKey).toBe('pk_real_capture');
      expect(await prisma.notification.count()).toBe(0);
    });

    it('returns 409 Milestone is already funded for a funded milestone without a completed payment [PY10]', async () => {
      const { client, milestone } = await activeScenario();
      await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED' } });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { message: 'Milestone is already funded' } });
    });

    it('repairs a PENDING milestone whose payment is already COMPLETED: funds it, 200 [PY11]', async () => {
      const { client, milestone } = await activeScenario();
      const completed = await makePayment(milestone.id, client.id, { status: 'COMPLETED', amount: 1 });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(200);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
      expect(after.amount).toBe(CONTRACT_AMOUNT);
      const milestoneAfter = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
      expect(milestoneAfter.status).toBe('FUNDED');
    });

    it('returns 409 for a REFUNDED payment and leaves it refunded [PY10]', async () => {
      const { client, milestone } = await activeScenario();
      const refunded = await makePayment(milestone.id, client.id, { status: 'REFUNDED' });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('Payment cannot be completed for a refunded milestone');

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: refunded.id } });
      expect(after.status).toBe('REFUNDED');
    });

    // [D22] With no payment row yet, two concurrent dev-completes both read "no payment" and
    // both `tx.payment.create` — the loser hits the unique `milestoneId` inside its transaction
    // (P2002) and answers 500. Same class as D13, on the dev-only route. Several rounds, because
    // a serialized pair produces 201 then 200 and no collision at all.
    it.fails('never returns 5xx when two dev-completes race on a milestone with no payment [D22]', async () => {
      const client = await makeClient();
      const freelancer = await makeFreelancer();
      const milestones = [
        (await extraActiveContract(client, freelancer)).milestone,
        (await extraActiveContract(client, freelancer)).milestone,
        (await extraActiveContract(client, freelancer)).milestone,
      ];
      await warmConnectionPool(client);
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        for (const milestone of milestones) {
          const responses = await withBypassEnabled(() => Promise.all([
            authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
            authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
          ]));
          for (const res of responses) {
            expect(res.status).toBeLessThan(500);
          }
        }
      } finally {
        logs.mockRestore();
      }
    });

    it('never contacts TossPayments', async () => {
      const { client, milestone } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
      );

      expect(res.status).toBe(201);
      expect(tossPost).not.toHaveBeenCalled();
      expect(tossGet).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/payments — the caller's payments
// ---------------------------------------------------------------------------

describe('GET /api/payments', () => {
  it('returns an empty array when the caller has no payments', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns the payment with its contract, project, freelancer and milestone [PY12] [C1]', async () => {
    const { client, freelancer, project, contract, milestone } = await activeScenario();
    const payment = await makePayment(milestone.id, client.id, { status: 'COMPLETED' });

    const res = await authed(client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: payment.id,
      orderId: payment.orderId,
      amount: CONTRACT_AMOUNT,
      status: 'COMPLETED',
      contract: {
        id: contract.id,
        project: { id: project.id, title: project.title },
        freelancer: { id: freelancer.id, name: freelancer.name },
      },
      milestone: { id: milestone.id, sequence: 1, title: milestone.title },
    });
    expect(Object.keys(res.body[0].milestone).sort()).toEqual(['id', 'sequence', 'title']);
    // The nested selects are narrow on purpose — no freelancer email leaks through.
    expect(Object.keys(res.body[0].contract.freelancer).sort()).toEqual(['id', 'name']);
    expect(Object.keys(res.body[0].contract.project).sort()).toEqual(['id', 'title']);
  });

  it('orders payments newest first [PY12]', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const older = await extraActiveContract(client, freelancer);
    const middle = await extraActiveContract(client, freelancer);
    const newer = await extraActiveContract(client, freelancer);

    await makePayment(older.milestone.id, client.id, { createdAt: new Date('2026-01-01T00:00:00Z') });
    await makePayment(newer.milestone.id, client.id, { createdAt: new Date('2026-03-01T00:00:00Z') });
    await makePayment(middle.milestone.id, client.id, { createdAt: new Date('2026-02-01T00:00:00Z') });

    const res = await authed(client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body.map((p: { contractId: string }) => p.contractId)).toEqual([
      newer.contract.id,
      middle.contract.id,
      older.contract.id,
    ]);
  });

  it("does not expose another client's payments [PY12]", async () => {
    const mine = await activeScenario();
    const theirs = await activeScenario();
    const myPayment = await makePayment(mine.milestone.id, mine.client.id);
    await makePayment(theirs.milestone.id, theirs.client.id);

    const res = await authed(mine.client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(myPayment.id);
    expect(await prisma.payment.count()).toBe(2);
  });

  it('returns nothing for a freelancer, since payments are scoped by clientId', async () => {
    const { freelancer, client, milestone } = await activeScenario();
    await makePayment(milestone.id, client.id);

    const res = await authed(freelancer).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting rule 1 — "Only status 500 is logged"
// ---------------------------------------------------------------------------

/**
 * The D8 `it.fails` above proves the discarded provider fault by showing that **nothing**
 * mentioning it reaches `console.error`. That argument only holds while `errorHandler` logs
 * nothing below 500 — D8's 400 path is silent for two independent reasons (the cause is
 * dropped *and* 4xx is never logged), and if a stray `console.error` were ever added to a 4xx
 * path, D8 would start passing on the new log line instead and quietly stop testing anything.
 *
 * These two tests pin the premise, using the payments endpoints to reach each status.
 */
describe('errorHandler logging (cross-cutting rule 1)', () => {
  it('logs nothing for 400, 403, 404 and 409 responses [C7]', async () => {
    const { client, freelancer, milestone } = await activeScenario();
    const settled = await activeScenario();
    await prisma.milestone.update({ where: { id: settled.milestone.id }, data: { status: 'FUNDED' } });
    await makePayment(settled.milestone.id, settled.client.id, { status: 'COMPLETED' });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const badRequest = await authed(client).post('/api/payments').send({});
      const forbidden = await authed(freelancer)
        .post('/api/payments')
        .send({ milestoneId: milestone.id });
      const notFound = await authed(client)
        .post('/api/payments')
        .send({ milestoneId: '00000000-0000-0000-0000-000000000000' });
      const conflict = await authed(settled.client)
        .post('/api/payments')
        .send({ milestoneId: settled.milestone.id });

      // Guards the test itself: each request must actually reach the status it is named for,
      // otherwise "nothing was logged" would be vacuously true.
      expect([badRequest.status, forbidden.status, notFound.status, conflict.status]).toEqual([
        400, 403, 404, 409,
      ]);

      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a 500 exactly once [C7]', async () => {
    const { client } = await activeScenario();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A non-string `milestoneId` survives `!milestoneId` and makes Prisma reject the
      // milestone lookup — the same vector as the deterministic [D14] test.
      const res = await authed(client).post('/api/payments').send({ milestoneId: 12345 });

      // Rule 1 ties logging to the status, so assert the pairing rather than the status alone:
      // rule 8 says this malformed value ought to be a 400, and that fix must not turn this
      // test into a lie.
      expect(spy.mock.calls).toHaveLength(res.status === 500 ? 1 : 0);

      // Coverage tripwire, not an endorsement: if this vector stops producing a 500, the
      // assertion above silently stops exercising the "500 *is* logged" half of rule 1.
      expect(
        res.status,
        'this vector no longer returns 500, so rule 1\'s logging branch is uncovered — pick a new one',
      ).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// System messages (MG6): funding that transitions the milestone posts MILESTONE_FUNDED once
// ---------------------------------------------------------------------------------------------

describe('MILESTONE_FUNDED system message', () => {
  const fundedMessages = (conversationId: string) =>
    prisma.message.findMany({ where: { conversationId, kind: 'SYSTEM', systemEvent: 'MILESTONE_FUNDED' } });

  async function pendingPayment() {
    const scenario = await activeScenario();
    const payment = await makePayment(scenario.milestone.id, scenario.client.id, { status: 'PENDING' });
    return { ...scenario, payment };
  }

  const confirmBody = (orderId: string) => ({ paymentKey: 'pk_test_123', orderId, amount: CONTRACT_AMOUNT });

  it('a confirmation posts it in the funding transaction [MG6] [PY7]', async () => {
    const { client, conversation, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());

    const res = await authed(client).post('/api/payments/confirm').send(confirmBody(payment.orderId));

    expect(res.status).toBe(200);
    const messages = await fundedMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderId: null, deletedAt: null });
  });

  it('a failed verification posts nothing [MG6] [PY8]', async () => {
    const { client, conversation, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone(1));

    const res = await authed(client).post('/api/payments/confirm').send(confirmBody(payment.orderId));

    expect(res.status).toBe(400);
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it('two concurrent confirms post it once — the no-op loser posts nothing [MG6] [PY9]', async () => {
    const { client, conversation, payment } = await pendingPayment();
    tossPost.mockResolvedValue(tossDone());
    await warmConnectionPool(client);

    await Promise.all([
      authed(client).post('/api/payments/confirm').send(confirmBody(payment.orderId)),
      authed(client).post('/api/payments/confirm').send(confirmBody(payment.orderId)),
    ]);

    expect(await fundedMessages(conversation.id)).toHaveLength(1);
  });

  it('dev-complete posts it once; the idempotent repeat posts nothing [MG6] [PY11]', async () => {
    const { client, conversation, milestone } = await activeScenario();

    const first = await withBypassEnabled(() =>
      authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
    );
    const again = await withBypassEnabled(() =>
      authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
    );

    expect([first.status, again.status]).toEqual([201, 200]);
    expect(await fundedMessages(conversation.id)).toHaveLength(1);
  });

  it('funds a milestone whose contract has no conversation, posting nothing [MG7] [PY11]', async () => {
    const { client, conversation, milestone } = await activeScenario();
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });

    const res = await withBypassEnabled(() =>
      authed(client).post('/api/payments/dev-complete').send({ milestoneId: milestone.id }),
    );

    expect(res.status).toBe(201);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).status).toBe('FUNDED');
    expect(await prisma.message.count()).toBe(0);
  });
});
