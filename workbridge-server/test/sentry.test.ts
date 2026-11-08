import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Registered before the app loads: `lib/sentry.ts` imports `@sentry/node` dynamically, and that
// import resolves to this mock.
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock('@sentry/node', () => sentry);

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient } from './helpers/factories';
import { registry } from '../src/jobs/registry';
import { PermanentJobError } from '../src/jobs/errors';
import { runDueJobs } from '../src/jobs/runner';

/**
 * Sentry error reporting (`lib/sentry.ts`): a 500 and a failed job are captured when
 * `SENTRY_DSN` is set, and nothing is when it is not. The 500 vector and the failing-job setup
 * are the ones `request-id.test.ts` and `jobs.test.ts` use.
 */

const DSN = 'https://public@o0.ingest.sentry.io/0';

/** A non-string `milestoneId` makes Prisma reject the lookup — the suite's standing 500 vector. */
async function provoke500(requestId: string) {
  const client = await makeClient();
  const res = await authed(client).post('/api/payments').set('X-Request-Id', requestId).send({ milestoneId: 12345 });
  return { res, client };
}

// `init` is deliberately not cleared: the SDK is initialized once per process (this file's module
// registry), and the test below checks that.
beforeEach(() => {
  sentry.captureException.mockClear();
  sentry.flush.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SENTRY_DSN;
  vi.restoreAllMocks();
});

describe('without SENTRY_DSN', () => {
  it('a 500 is still logged once, but nothing is captured or flushed', async () => {
    const { res } = await provoke500('trace-off');

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });
});

describe('with SENTRY_DSN', () => {
  beforeEach(() => {
    process.env.SENTRY_DSN = DSN;
  });

  it('a 500 is captured once with the request id, method, path and user, and flushed before the response', async () => {
    const { res, client } = await provoke500('trace-sentry');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
    expect(console.error).toHaveBeenCalledTimes(1);

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = sentry.captureException.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(err).toBeInstanceOf(Error);
    expect(context).toMatchObject({
      tags: { requestId: 'trace-sentry', method: 'POST', path: '/api/payments' },
      user: { id: client.id },
    });
    expect(sentry.flush).toHaveBeenCalledWith(2000);
  });

  it('initializes the SDK once, with errors only and no PII', async () => {
    await provoke500('trace-init');
    await provoke500('trace-init-2');

    expect(sentry.captureException).toHaveBeenCalledTimes(2);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: DSN,
      environment: 'test',
      tracesSampleRate: 0,
      sendDefaultPii: false,
    }));
  });

  it('a 4xx is not captured', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/projects/missing-project-id');

    expect(res.status).toBe(404);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it('a flush that times out still sends the 500', async () => {
    sentry.flush.mockResolvedValueOnce(false);

    const { res } = await provoke500('trace-timeout');

    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('a failing job is captured once with its id, type and attempt, and flushed', async () => {
    vi.spyOn(registry, 'maintenance.cleanup').mockImplementation(async () => {
      throw new PermanentJobError('bad payload');
    });
    const job = await prisma.job.create({
      data: { type: 'maintenance.cleanup', runAt: new Date(Date.now() - 1000) },
    });

    expect((await runDueJobs()).failed).toBe(1);

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = sentry.captureException.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(err).toBeInstanceOf(PermanentJobError);
    expect(context).toMatchObject({
      tags: { jobId: job.id, jobType: 'maintenance.cleanup', attempt: '1' },
    });
    expect(sentry.flush).toHaveBeenCalled();
  });

  it('a job that will retry is not captured', async () => {
    vi.spyOn(registry, 'maintenance.cleanup').mockImplementation(async () => {
      throw new Error('transient');
    });
    await prisma.job.create({ data: { type: 'maintenance.cleanup', runAt: new Date(Date.now() - 1000) } });

    expect((await runDueJobs()).retried).toBe(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('a failing job without SENTRY_DSN', () => {
  it('is not captured', async () => {
    vi.spyOn(registry, 'maintenance.cleanup').mockImplementation(async () => {
      throw new PermanentJobError('bad payload');
    });
    await prisma.job.create({ data: { type: 'maintenance.cleanup', runAt: new Date(Date.now() - 1000) } });

    expect((await runDueJobs()).failed).toBe(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
