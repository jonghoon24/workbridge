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
 * A second (or third) active contract for an existing pair. `Payment.contractId` is unique,
 * so a client with several payments needs several contracts.
 */
async function extraActiveContract(client: User, freelancer: User) {
  const project = await makeProject(client.id, { status: 'CLOSED' });
  const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
  return makeContract(
    {
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    },
    { status: 'ACTIVE' },
  );
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
  ['a raw column reference', /`contractId`/],
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
  it('rejects a missing contractId with 400 and writes nothing', async () => {
    const { client } = await activeScenario();

    const res = await authed(client).post('/api/payments').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Contract ID is required' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 404 for a contract that does not exist', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/payments')
      .send({ contractId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Contract not found' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("returns 403 when the caller is the contract's freelancer, not the paying client", async () => {
    const { freelancer, contract } = await activeScenario();

    const res = await authed(freelancer).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 403 for an unrelated client', async () => {
    const { contract } = await activeScenario();
    const outsider = await makeClient();

    const res = await authed(outsider).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Not authorized');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 400 for a PENDING (unsigned) contract', async () => {
    const { client, contract } = await makeContractScenario();
    expect(contract.status).toBe('PENDING');

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('returns 400 for a COMPLETED contract', async () => {
    const { client, contract } = await activeScenario({ status: 'COMPLETED' });

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('creates a PENDING payment with a fresh orderId and 201 when none exists', async () => {
    const { client, contract } = await activeScenario();

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

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
      clientId: client.id,
      amount: CONTRACT_AMOUNT,
      status: 'PENDING',
      paymentKey: null,
    });
  });

  it('takes the amount from the contract and ignores an amount in the request body', async () => {
    const { client, contract } = await activeScenario({ amount: 7_500_000 });

    const res = await authed(client)
      .post('/api/payments')
      .send({ contractId: contract.id, amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(7_500_000);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { contractId: contract.id } });
    expect(payment.amount).toBe(7_500_000);
  });

  it('resumes an existing PENDING payment: same orderId, 200, no second row', async () => {
    const { client, contract } = await activeScenario();
    const existing = await makePayment(contract.id, client.id, { status: 'PENDING' });

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

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

  it('retries a FAILED payment: resets to PENDING with a new orderId and cleared paymentKey', async () => {
    const { client, contract } = await activeScenario();
    const failed = await makePayment(contract.id, client.id, {
      status: 'FAILED',
      paymentKey: 'pk_from_failed_attempt',
      amount: 1, // must be re-derived from the contract on retry
    });

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

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

  it('returns 409 when the payment is already COMPLETED, leaving it untouched', async () => {
    const { client, contract } = await activeScenario();
    const completed = await makePayment(contract.id, client.id, {
      status: 'COMPLETED',
      paymentKey: 'pk_settled',
    });

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { message: 'Payment already completed for this contract' },
    });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
    expect(after).toMatchObject({
      status: 'COMPLETED',
      orderId: completed.orderId,
      paymentKey: 'pk_settled',
    });
    expect(await prisma.payment.count()).toBe(1);
  });

  it('returns 409 when the payment is REFUNDED, leaving it untouched', async () => {
    const { client, contract } = await activeScenario();
    const refunded = await makePayment(contract.id, client.id, {
      status: 'REFUNDED',
      paymentKey: 'pk_refunded',
    });

    const res = await authed(client).post('/api/payments').send({ contractId: contract.id });

    expect(res.status).toBe(409);
    expect(typeof res.body.error.message).toBe('string');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: refunded.id } });
    expect(after).toMatchObject({ status: 'REFUNDED', orderId: refunded.orderId });
    expect(await prisma.payment.count()).toBe(1);
  });

  // [D13] `Payment.contractId` is unique and `createPayment` never catches P2002, so when two
  // requests both read `contract.payment === null` the loser's `prisma.payment.create` rejects
  // and reaches `errorHandler` without a `statusCode`.
  //
  // Verified today: one **201** and one **500**. Cross-cutting rule 8 requires a
  // unique-constraint collision to be a **409** — the same defect class as D4, which was fixed
  // for `Contract.projectId` but never for the money path. Either request may legitimately win,
  // so the assertion is on the set of acceptable statuses (create → 201, resume → 200,
  // collision → 409) rather than on which one each request got.
  it.fails(
    'never returns 5xx when two concurrent creates collide on the unique contractId [D13]',
    async () => {
      const { client, contract } = await activeScenario();
      await warmConnectionPool(client);
      // The 500 is logged by `errorHandler`; silence it so the intended failure is readable.
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const responses = await Promise.all([
          authed(client).post('/api/payments').send({ contractId: contract.id }),
          authed(client).post('/api/payments').send({ contractId: contract.id }),
        ]);

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
  // **absolute source path**, a source excerpt and the offending argument. Verified today, this
  // request returns 500 with:
  //
  //   Invalid `prisma.contract.findUnique()` invocation in
  //   /Users/…/workbridge-server/src/controllers/payments.controller.ts:20:44
  //     …
  //   → 20 const contract = await prisma.contract.findUnique({
  //          where: { id: 12345
  //   Argument `id`: Invalid value provided. Expected String, provided Int.
  //
  // Deliberately status-agnostic: rule 8 says a malformed value should be a 400 rather than a
  // 500, but *no* status may expose internals, so fixing either defect independently still
  // leaves this test meaningful.
  it.fails(
    'does not expose file paths or source excerpts when Prisma rejects a malformed contractId [D14]',
    async () => {
      const { client } = await activeScenario();
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const res = await authed(client).post('/api/payments').send({ contractId: 12345 });

        expect(res.body).toHaveProperty('error.message');
        assertNoInternalsLeak(res.body.error.message);
      } finally {
        logs.mockRestore();
      }
    },
  );

  // [D14] The same leak on the money path specifically: the D13 collision's 500 body carries
  // `Invalid \`prisma.payment.create()\` invocation in /Users/…/src/controllers/
  // payments.controller.ts:70:42`, the surrounding source lines, and
  // ``Unique constraint failed on the fields: (`contractId`)`` — i.e. the schema's column name.
  //
  // Several rounds are run because the collision is a real race and a serialized pair produces
  // no 500 at all. The assertion itself never requires a 500 to have happened: it is the
  // invariant "no error body leaks internals", checked over every response.
  it.fails('does not leak Prisma internals in the 500 body from a create collision [D14]', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const contracts = [
      await extraActiveContract(client, freelancer),
      await extraActiveContract(client, freelancer),
      await extraActiveContract(client, freelancer),
    ];
    await warmConnectionPool(client);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const contract of contracts) {
        const responses = await Promise.all([
          authed(client).post('/api/payments').send({ contractId: contract.id }),
          authed(client).post('/api/payments').send({ contractId: contract.id }),
        ]);

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
    const payment = await makePayment(scenario.contract.id, scenario.client.id, {
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
    const { client, contract } = await activeScenario();
    const payment = await makePayment(contract.id, client.id, {
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
    const { client, contract } = await activeScenario();
    const payment = await makePayment(contract.id, client.id, { status: 'FAILED' });

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
    const { client, contract } = await activeScenario();
    const payment = await makePayment(contract.id, client.id, { status: 'REFUNDED' });

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
    const { client, contract, payment } = await pendingPayment();
    tossPost.mockRejectedValue(new Error('gateway timeout'));

    await authed(client).post('/api/payments/confirm').send(body(payment.orderId, CONTRACT_AMOUNT));

    const resume = await authed(client).post('/api/payments').send({ contractId: contract.id });
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
});

// ---------------------------------------------------------------------------
// POST /api/payments/dev-complete — local/demo bypass
// ---------------------------------------------------------------------------

describe('POST /api/payments/dev-complete', () => {
  describe('when the bypass is disabled', () => {
    it("returns 403 with ALLOW_PAYMENT_BYPASS='false' and writes nothing", async () => {
      expect(process.env.ALLOW_PAYMENT_BYPASS).toBe('false');
      const { client, contract } = await activeScenario();

      const res = await authed(client)
        .post('/api/payments/dev-complete')
        .send({ contractId: contract.id });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: 'Payment bypass is disabled' } });
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 403 when ALLOW_PAYMENT_BYPASS is unset', async () => {
      const previous = process.env.ALLOW_PAYMENT_BYPASS;
      delete process.env.ALLOW_PAYMENT_BYPASS;
      try {
        const { client, contract } = await activeScenario();

        const res = await authed(client)
          .post('/api/payments/dev-complete')
          .send({ contractId: contract.id });

        expect(res.status).toBe(403);
        expect(res.body.error.message).toBe('Payment bypass is disabled');
      } finally {
        if (previous === undefined) delete process.env.ALLOW_PAYMENT_BYPASS;
        else process.env.ALLOW_PAYMENT_BYPASS = previous;
      }
    });

    it("returns 403 for a value that is merely truthy, like '1'", async () => {
      const previous = process.env.ALLOW_PAYMENT_BYPASS;
      process.env.ALLOW_PAYMENT_BYPASS = '1';
      try {
        const { client, contract } = await activeScenario();

        const res = await authed(client)
          .post('/api/payments/dev-complete')
          .send({ contractId: contract.id });

        expect(res.status).toBe(403);
      } finally {
        if (previous === undefined) delete process.env.ALLOW_PAYMENT_BYPASS;
        else process.env.ALLOW_PAYMENT_BYPASS = previous;
      }
    });

    it('is checked before anything else — a missing contractId still returns 403, not 400', async () => {
      const { client } = await activeScenario();

      const res = await authed(client).post('/api/payments/dev-complete').send({});

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Payment bypass is disabled');
    });

    it('leaves a completed payment path unreachable: an existing PENDING payment is untouched', async () => {
      const { client, contract } = await activeScenario();
      const payment = await makePayment(contract.id, client.id, { status: 'PENDING' });

      await authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id });

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after).toMatchObject({ status: 'PENDING', paymentKey: null });
    });
  });

  describe('when the bypass is enabled', () => {
    it('rejects a missing contractId with 400', async () => {
      const { client } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({}),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Contract ID is required' } });
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 404 for a contract that does not exist', async () => {
      const client = await makeClient();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: 'nope' }),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Contract not found');
    });

    it('returns 403 for the freelancer on the contract', async () => {
      const { freelancer, contract } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(freelancer).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Not authorized');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 403 for an unrelated client', async () => {
      const { contract } = await activeScenario();
      const outsider = await makeClient();

      const res = await withBypassEnabled(() =>
        authed(outsider).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(403);
      expect(await prisma.payment.count()).toBe(0);
    });

    it('returns 400 for a contract that is not ACTIVE', async () => {
      const { client, contract } = await makeContractScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Contract must be active to proceed with payment');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('creates a COMPLETED payment with paymentKey dev_bypass_<contractId> and 201', async () => {
      const { client, contract } = await activeScenario();

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        contractId: contract.id,
        clientId: client.id,
        amount: CONTRACT_AMOUNT,
        status: 'COMPLETED',
        paymentKey: `dev_bypass_${contract.id}`,
      });
      expect(res.body.orderId).toMatch(/^dev-/);

      const payments = await prisma.payment.findMany();
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        id: res.body.id,
        status: 'COMPLETED',
        paymentKey: `dev_bypass_${contract.id}`,
        amount: CONTRACT_AMOUNT,
      });
    });

    it('completes an existing PENDING payment in place, keeping its orderId and row', async () => {
      const { client, contract } = await activeScenario();
      const pending = await makePayment(contract.id, client.id, {
        status: 'PENDING',
        amount: 1, // re-derived from the contract
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(pending.id);
      expect(res.body.orderId).toBe(pending.orderId);

      expect(await prisma.payment.count()).toBe(1);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: pending.id } });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        paymentKey: `dev_bypass_${contract.id}`,
        amount: CONTRACT_AMOUNT,
        orderId: pending.orderId,
      });
    });

    it('completes an existing FAILED payment in place', async () => {
      const { client, contract } = await activeScenario();
      const failed = await makePayment(contract.id, client.id, {
        status: 'FAILED',
        paymentKey: 'pk_stale',
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(200);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: failed.id } });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        paymentKey: `dev_bypass_${contract.id}`,
      });
    });

    it('is idempotent: an already COMPLETED payment is returned unchanged', async () => {
      const { client, contract } = await activeScenario();
      const completed = await makePayment(contract.id, client.id, {
        status: 'COMPLETED',
        paymentKey: 'pk_real_toss_key',
      });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: completed.id,
        orderId: completed.orderId,
        status: 'COMPLETED',
        paymentKey: 'pk_real_toss_key',
      });

      // The real provider key must not be overwritten with the bypass marker.
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: completed.id } });
      expect(after).toMatchObject({ status: 'COMPLETED', paymentKey: 'pk_real_toss_key' });
      expect(await prisma.payment.count()).toBe(1);
    });

    it('returns 409 for a REFUNDED payment and leaves it refunded', async () => {
      const { client, contract } = await activeScenario();
      const refunded = await makePayment(contract.id, client.id, { status: 'REFUNDED' });

      const res = await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'Payment cannot be completed for a refunded contract',
      );

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: refunded.id } });
      expect(after.status).toBe('REFUNDED');
    });

    it('never contacts TossPayments', async () => {
      const { client, contract } = await activeScenario();

      await withBypassEnabled(() =>
        authed(client).post('/api/payments/dev-complete').send({ contractId: contract.id }),
      );

      expect(tossPost).not.toHaveBeenCalled();
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

  it('returns the payment with its contract, project, and freelancer', async () => {
    const { client, freelancer, project, contract } = await activeScenario();
    const payment = await makePayment(contract.id, client.id, { status: 'COMPLETED' });

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
    });
    // The nested selects are narrow on purpose — no freelancer email leaks through.
    expect(Object.keys(res.body[0].contract.freelancer).sort()).toEqual(['id', 'name']);
    expect(Object.keys(res.body[0].contract.project).sort()).toEqual(['id', 'title']);
  });

  it('orders payments newest first', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const older = await extraActiveContract(client, freelancer);
    const middle = await extraActiveContract(client, freelancer);
    const newer = await extraActiveContract(client, freelancer);

    await makePayment(older.id, client.id, { createdAt: new Date('2026-01-01T00:00:00Z') });
    await makePayment(newer.id, client.id, { createdAt: new Date('2026-03-01T00:00:00Z') });
    await makePayment(middle.id, client.id, { createdAt: new Date('2026-02-01T00:00:00Z') });

    const res = await authed(client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body.map((p: { contractId: string }) => p.contractId)).toEqual([
      newer.id,
      middle.id,
      older.id,
    ]);
  });

  it("does not expose another client's payments", async () => {
    const mine = await activeScenario();
    const theirs = await activeScenario();
    const myPayment = await makePayment(mine.contract.id, mine.client.id);
    await makePayment(theirs.contract.id, theirs.client.id);

    const res = await authed(mine.client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(myPayment.id);
    expect(await prisma.payment.count()).toBe(2);
  });

  it('returns nothing for a freelancer, since payments are scoped by clientId', async () => {
    const { freelancer, client, contract } = await activeScenario();
    await makePayment(contract.id, client.id);

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
  it('logs nothing for 400, 403, 404 and 409 responses', async () => {
    const { client, freelancer, contract } = await activeScenario();
    const settled = await activeScenario();
    await makePayment(settled.contract.id, settled.client.id, { status: 'COMPLETED' });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const badRequest = await authed(client).post('/api/payments').send({});
      const forbidden = await authed(freelancer)
        .post('/api/payments')
        .send({ contractId: contract.id });
      const notFound = await authed(client)
        .post('/api/payments')
        .send({ contractId: '00000000-0000-0000-0000-000000000000' });
      const conflict = await authed(settled.client)
        .post('/api/payments')
        .send({ contractId: settled.contract.id });

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

  it('logs a 500 exactly once', async () => {
    const { client } = await activeScenario();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A non-string `contractId` survives `!contractId` and makes Prisma reject the
      // `findUnique` — the same vector as the deterministic [D14] test.
      const res = await authed(client).post('/api/payments').send({ contractId: 12345 });

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
