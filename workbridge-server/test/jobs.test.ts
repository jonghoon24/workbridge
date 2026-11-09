import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Prisma } from '@prisma/client';

import { api } from './helpers/api';
import { prisma } from './helpers/db';
import { atDaysFromNow, jobsOf, runJobs } from './helpers/jobs';
import { daysFromNow, makeApplication, makeClient, makeFreelancer, makeProject } from './helpers/factories';
import { PermanentJobError } from '../src/jobs/errors';
import { enqueueJob } from '../src/jobs/queue';
import { ensureRecurringJobs, RECURRING_JOBS } from '../src/jobs/recurring';
import { registry } from '../src/jobs/registry';
import { backoffMs, recoverStaleJobs, runDueJobs, STALE_LOCK_MS } from '../src/jobs/runner';
import { startJobWorker } from '../src/jobs/worker';
import { runWithContext } from '../src/lib/requestContext';

/**
 * The Postgres job queue (see `docs/domain/jobs.md`).
 *
 * The generic queue tests below run `maintenance.cleanup` jobs with its handler replaced by a
 * spy. Claiming a recurring job also
 * enqueues its next slot, which is why these tests look rows up by id rather than counting.
 */

const TYPE = 'maintenance.cleanup' as const;

function spyHandler(impl: () => Promise<void> = async () => undefined) {
  return vi.spyOn(registry, TYPE).mockImplementation(impl);
}

function reload(job: Pick<Job, 'id'>): Promise<Job> {
  return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
}

async function makeJob(overrides: Partial<Prisma.JobUncheckedCreateInput> = {}): Promise<Job> {
  return prisma.job.create({ data: { type: TYPE, runAt: new Date(Date.now() - 1000), ...overrides } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------------------------

describe('enqueueJob', () => {
  it('inserts a PENDING job with the documented defaults', async () => {
    const before = Date.now();
    expect(await enqueueJob(prisma, { type: TYPE })).toBe(true);

    const [job] = await jobsOf(TYPE);
    expect(job).toMatchObject({ status: 'PENDING', attempts: 0, maxAttempts: 5, payload: {}, traceId: null });
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('is a silent no-op for an existing dedupeKey, whatever that job\'s status', async () => {
    await enqueueJob(prisma, { type: TYPE, dedupeKey: 'k1' });
    await prisma.job.updateMany({ data: { status: 'SUCCEEDED' } });

    expect(await enqueueJob(prisma, { type: TYPE, dedupeKey: 'k1' })).toBe(false);
    expect(await prisma.job.count()).toBe(1);
  });

  it('a duplicate inside a transaction does not abort the transaction', async () => {
    await enqueueJob(prisma, { type: TYPE, dedupeKey: 'dup' });
    const client = await makeClient();

    await prisma.$transaction(async (tx) => {
      await enqueueJob(tx, { type: TYPE, dedupeKey: 'dup' });
      // Would fail with "current transaction is aborted" if the duplicate had raised P2002.
      await tx.user.update({ where: { id: client.id }, data: { name: 'after duplicate' } });
    });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).name).toBe('after duplicate');
    expect(await prisma.job.count()).toBe(1);
  });

  it('rolls back with the transaction that enqueued it (transactional outbox)', async () => {
    await expect(prisma.$transaction(async (tx) => {
      await enqueueJob(tx, { type: TYPE });
      throw new Error('domain write failed');
    })).rejects.toThrow('domain write failed');

    expect(await prisma.job.count()).toBe(0);
  });

  it('records the current request id as traceId', async () => {
    await runWithContext({ requestId: 'req-trace-1' }, () => enqueueJob(prisma, { type: TYPE }));

    const [job] = await jobsOf(TYPE);
    expect(job.traceId).toBe('req-trace-1');
  });
});

// ---------------------------------------------------------------------------------------------
// claim and run
// ---------------------------------------------------------------------------------------------

describe('runDueJobs', () => {
  it('runs only jobs whose runAt has come', async () => {
    const handler = spyHandler();
    const now = new Date();
    const due = await makeJob({ runAt: new Date(now.getTime() - 1) });
    const exactlyNow = await makeJob({ runAt: now });
    const future = await makeJob({ runAt: new Date(now.getTime() + 1) });

    const result = await runDueJobs({ now });

    expect(result).toEqual({ claimed: 2, succeeded: 2, retried: 0, failed: 0, skipped: 0 });
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await reload(due)).status).toBe('SUCCEEDED');
    expect((await reload(exactlyNow)).status).toBe('SUCCEEDED');
    expect((await reload(future)).status).toBe('PENDING');
  });

  it('a success sets SUCCEEDED and completedAt = now, counts the attempt and releases the lock', async () => {
    const handler = spyHandler();
    const job = await makeJob({ payload: { anything: 1 } });
    const now = new Date();

    await runDueJobs({ now });

    const stored = await reload(job);
    expect(stored).toMatchObject({ status: 'SUCCEEDED', attempts: 1, lockedAt: null, lockedBy: null });
    expect(stored.completedAt?.toISOString()).toBe(now.toISOString());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      now,
      payload: { anything: 1 },
      job: expect.objectContaining({ id: job.id, status: 'RUNNING', attempts: 1 }),
    }));
  });

  it('a failure backs off — 30 s, then 60 s — and records lastError', async () => {
    spyHandler(async () => {
      throw new Error('provider down');
    });
    const job = await makeJob();
    const t1 = new Date();

    expect(await runDueJobs({ now: t1 })).toEqual({ claimed: 1, succeeded: 0, retried: 1, failed: 0, skipped: 0 });
    let stored = await reload(job);
    expect(stored).toMatchObject({ status: 'PENDING', attempts: 1, lockedAt: null, lockedBy: null });
    expect(stored.runAt.getTime()).toBe(t1.getTime() + 30_000);
    expect(stored.lastError).toContain('provider down');

    // Not due again until the backoff has elapsed.
    expect((await runDueJobs({ now: new Date(t1.getTime() + 29_999) })).claimed).toBe(0);

    const t2 = new Date(t1.getTime() + 30_000);
    await runDueJobs({ now: t2 });
    stored = await reload(job);
    expect(stored.attempts).toBe(2);
    expect(stored.runAt.getTime()).toBe(t2.getTime() + 60_000);
  });

  it('backoff doubles per attempt and is capped at one hour', () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(8)).toBe(3_600_000);
    expect(backoffMs(30)).toBe(3_600_000);
  });

  it('marks the job FAILED once maxAttempts is exhausted, and logs that at error level once', async () => {
    spyHandler(async () => {
      throw new Error('still down');
    });
    const job = await makeJob({ maxAttempts: 2 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const t1 = new Date();
    await runDueJobs({ now: t1 });
    expect(consoleError).not.toHaveBeenCalled();

    const result = await runDueJobs({ now: new Date(t1.getTime() + 30_000) });

    expect(result).toEqual({ claimed: 1, succeeded: 0, retried: 0, failed: 1, skipped: 0 });
    expect(await reload(job)).toMatchObject({ status: 'FAILED', attempts: 2, lockedBy: null });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(consoleError.mock.calls[0][0]));
    expect(line).toMatchObject({ level: 'error', msg: 'job failed', jobId: job.id, type: TYPE });
    expect(line.err.message).toBe('still down');
  });

  it('a PermanentJobError fails the job on the first attempt', async () => {
    spyHandler(async () => {
      throw new PermanentJobError('bad payload');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const job = await makeJob();

    expect((await runDueJobs()).failed).toBe(1);
    const stored = await reload(job);
    expect(stored).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(stored.lastError).toContain('bad payload');
  });

  it('a type with no handler fails permanently instead of retrying', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const job = await makeJob({ type: 'no.such.type' });

    expect((await runDueJobs()).failed).toBe(1);
    const stored = await reload(job);
    expect(stored).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(stored.lastError).toContain('No handler registered');
  });

  it('claims at most `limit` jobs, oldest runAt first', async () => {
    const seen: string[] = [];
    vi.spyOn(registry, TYPE).mockImplementation(async ({ job }) => {
      seen.push(job.id);
    });
    const base = Date.now() - 60_000;
    const third = await makeJob({ runAt: new Date(base + 2000) });
    const first = await makeJob({ runAt: new Date(base) });
    const second = await makeJob({ runAt: new Date(base + 1000) });

    const result = await runDueJobs({ limit: 2 });

    expect(result.claimed).toBe(2);
    expect(seen).toEqual([first.id, second.id]);
    expect((await reload(third)).status).toBe('PENDING');
  });

  it('can be restricted to some job types', async () => {
    spyHandler();
    const cleanup = await makeJob();
    const sweep = await makeJob({ type: 'project.lifecycleSweep' });

    await runDueJobs({ types: ['project.lifecycleSweep'] });

    expect((await reload(sweep)).status).toBe('SUCCEEDED');
    expect((await reload(cleanup)).status).toBe('PENDING');
  });

  it('never hands the same job to two concurrent runners', async () => {
    const runs = new Map<string, number>();
    vi.spyOn(registry, TYPE).mockImplementation(async ({ job }) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const jobs = await Promise.all(Array.from({ length: 20 }, () => makeJob()));
    const now = new Date();

    const [a, b] = await Promise.all([
      runDueJobs({ now, workerId: 'runner-a' }),
      runDueJobs({ now, workerId: 'runner-b' }),
    ]);

    expect(a.claimed + b.claimed).toBe(20);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
    expect(runs.size).toBe(20);
    for (const job of jobs) {
      expect((await reload(job)).status).toBe('SUCCEEDED');
    }
  });

  it('skips a locked row instead of waiting for it (FOR UPDATE SKIP LOCKED)', async () => {
    spyHandler();
    const locked = await makeJob();
    const free = await Promise.all([makeJob(), makeJob()]);

    // Another runner is mid-claim on `locked`: hold its row lock in an open transaction. With a
    // plain FOR UPDATE, runDueJobs would block until this transaction ends — i.e. never, since
    // the transaction is waiting for runDueJobs.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${locked.id} FOR UPDATE`;

      const outcome = await Promise.race([
        runDueJobs({ types: [TYPE] }),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2000)),
      ]);

      expect(outcome).toMatchObject({ claimed: 2, succeeded: 2 });
    }, { timeout: 10_000 });

    expect((await reload(locked)).status).toBe('PENDING');
    for (const job of free) expect((await reload(job)).status).toBe('SUCCEEDED');
  });

  it('re-asserts the lock before each job and skips one another runner has taken over', async () => {
    const first = await makeJob({ runAt: new Date(Date.now() - 2000) });
    const second = await makeJob({ runAt: new Date(Date.now() - 1000) });
    const ran: string[] = [];
    vi.spyOn(registry, TYPE).mockImplementation(async ({ job }) => {
      ran.push(job.id);
      // While the first job runs, recovery hands the second to another runner.
      if (job.id === first.id) {
        await prisma.job.update({ where: { id: second.id }, data: { lockedBy: 'other-runner' } });
      }
    });

    const result = await runDueJobs({ workerId: 'slow-runner' });

    expect(result).toEqual({ claimed: 2, succeeded: 1, retried: 0, failed: 0, skipped: 1 });
    expect(ran).toEqual([first.id]);
    expect(await reload(second)).toMatchObject({ status: 'RUNNING', lockedBy: 'other-runner' });
  });

  it('logs from inside a job carry its jobId and the enqueuing request id', async () => {
    await runWithContext({ requestId: 'trace-from-request' }, () => enqueueJob(prisma, { type: TYPE, runAt: new Date(Date.now() - 1000) }));
    const [job] = await jobsOf(TYPE);
    vi.spyOn(registry, TYPE).mockImplementation(async ({ logger }) => {
      logger.info('handler says hi');
      throw new Error('transient');
    });
    process.env.LOG_LEVEL = 'info';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runDueJobs();
    } finally {
      process.env.LOG_LEVEL = 'error';
    }

    const lines = out.mock.calls.map(([line]) => JSON.parse(String(line)));
    for (const msg of ['handler says hi', 'job will retry']) {
      expect(lines.find((line) => line.msg === msg)).toMatchObject({ jobId: job.id, requestId: 'trace-from-request' });
    }
  });

  it('does not overwrite a job whose lock was taken over while it ran', async () => {
    const job = await makeJob();
    vi.spyOn(registry, TYPE).mockImplementation(async () => {
      // Stale-lock recovery and another runner got to it in the meantime.
      await prisma.job.update({ where: { id: job.id }, data: { lockedBy: 'someone-else' } });
    });

    await runDueJobs({ workerId: 'slow-runner' });

    expect(await reload(job)).toMatchObject({ status: 'RUNNING', lockedBy: 'someone-else', completedAt: null });
  });
});

// ---------------------------------------------------------------------------------------------
// stale locks
// ---------------------------------------------------------------------------------------------

describe('recoverStaleJobs', () => {
  it('returns jobs locked for more than 10 minutes to PENDING, without refunding the attempt', async () => {
    const now = new Date();
    const stale = await makeJob({
      status: 'RUNNING', attempts: 2, lockedBy: 'dead', lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 1),
    });
    const fresh = await makeJob({
      status: 'RUNNING', attempts: 1, lockedBy: 'alive', lockedAt: new Date(now.getTime() - STALE_LOCK_MS + 60_000),
    });

    expect(await recoverStaleJobs(now)).toEqual({ requeued: 1, failed: 0 });

    expect(await reload(stale)).toMatchObject({ status: 'PENDING', attempts: 2, lockedAt: null, lockedBy: null });
    expect(await reload(fresh)).toMatchObject({ status: 'RUNNING', lockedBy: 'alive' });
  });

  it('fails a stale job that has used up its attempts instead of requeueing it forever', async () => {
    const now = new Date();
    const exhausted = await makeJob({
      status: 'RUNNING', attempts: 5, maxAttempts: 5, lockedBy: 'dead', lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 1),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await recoverStaleJobs(now)).toEqual({ requeued: 0, failed: 1 });

    expect(await reload(exhausted)).toMatchObject({
      status: 'FAILED', lockedBy: null, lastError: 'stale lock, attempts exhausted',
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0][0]))).toMatchObject({ msg: 'job failed', jobId: exhausted.id });
    expect((await runDueJobs({ now })).claimed).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// the polling worker
// ---------------------------------------------------------------------------------------------

describe('startJobWorker', () => {
  async function until(condition: () => Promise<boolean>, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('condition not reached in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('ensures recurring jobs, recovers stale ones and runs due jobs on every poll, and stops cleanly', async () => {
    const handler = spyHandler();
    const due = await makeJob();
    const stale = await makeJob({
      status: 'RUNNING', attempts: 1, lockedBy: 'dead', lockedAt: new Date(Date.now() - STALE_LOCK_MS - 60_000),
    });

    const worker = startJobWorker({ intervalMs: 10, handleSignals: false });
    try {
      await until(async () => (await reload(due)).status === 'SUCCEEDED' && (await reload(stale)).status === 'SUCCEEDED');
      expect((await jobsOf('project.lifecycleSweep')).length).toBe(1);

      // A re-seed wipes every job; the next poll puts the schedule back.
      await prisma.job.deleteMany({ where: { type: 'project.lifecycleSweep' } });
      await until(async () => (await jobsOf('project.lifecycleSweep')).length === 1);
    } finally {
      await worker.stop();
    }

    const callsAtStop = handler.mock.calls.length;
    await makeJob();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handler.mock.calls.length).toBe(callsAtStop);
  });
});

// ---------------------------------------------------------------------------------------------
// recurring jobs
// ---------------------------------------------------------------------------------------------

describe('recurring jobs', () => {
  // 2026-10-21 10:03 KST.
  const T0 = new Date('2026-10-21T01:03:00.000Z');

  it('ensureRecurringJobs queues the next slot of every recurring type', async () => {
    expect(await ensureRecurringJobs(T0)).toBe(RECURRING_JOBS.length);

    const [sweep] = await jobsOf('project.lifecycleSweep');
    expect(sweep.runAt.toISOString()).toBe('2026-10-21T01:10:00.000Z');
    expect(sweep.dedupeKey).toBe('project.lifecycleSweep:2026-10-21T01:10:00.000Z');

    // Next 04:00 KST after 10:03 KST is tomorrow's.
    const [cleanup] = await jobsOf('maintenance.cleanup');
    expect(cleanup.runAt.toISOString()).toBe('2026-10-21T19:00:00.000Z');
    expect(cleanup.dedupeKey).toBe('maintenance.cleanup:2026-10-22');
  });

  it('is idempotent', async () => {
    await ensureRecurringJobs(T0);
    expect(await ensureRecurringJobs(new Date(T0.getTime() + 60_000))).toBe(0);
    expect(await prisma.job.count()).toBe(RECURRING_JOBS.length);
  });

  it('takes the slot strictly after now, even on a boundary', async () => {
    await ensureRecurringJobs(new Date('2026-10-21T01:10:00.000Z'));

    const [sweep] = await jobsOf('project.lifecycleSweep');
    expect(sweep.runAt.toISOString()).toBe('2026-10-21T01:20:00.000Z');
  });

  it('runDueJobs itself never creates recurring jobs', async () => {
    expect(await runJobs()).toEqual({ claimed: 0, succeeded: 0, retried: 0, failed: 0, skipped: 0 });
    expect(await prisma.job.count()).toBe(0);
  });

  it('claiming a slot queues the next one, even when the run then fails', async () => {
    vi.spyOn(registry, 'project.lifecycleSweep').mockImplementation(async () => {
      throw new PermanentJobError('this slot fails');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ensureRecurringJobs(T0);

    // A runner that was down for an hour: one catch-up run, then the slot after the claim.
    const late = new Date('2026-10-21T02:05:00.000Z');
    const result = await runDueJobs({ now: late, types: ['project.lifecycleSweep'] });

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    const sweeps = await jobsOf('project.lifecycleSweep');
    expect(sweeps.map((job) => [job.status, job.runAt.toISOString()])).toEqual([
      ['FAILED', '2026-10-21T01:10:00.000Z'],
      ['PENDING', '2026-10-21T02:10:00.000Z'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// job types
// ---------------------------------------------------------------------------------------------

describe('project.lifecycleSweep', () => {
  async function scenario() {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const open = await makeProject(client.id, { status: 'OPEN', deadline: daysFromNow(2) });
    const application = await makeApplication(open.id, freelancer.id);
    const upcoming = await makeProject(client.id, {
      status: 'UPCOMING',
      recruitmentStartDate: daysFromNow(1),
      deadline: daysFromNow(5),
    });
    await enqueueJob(prisma, { type: 'project.lifecycleSweep', runAt: new Date() });
    return { open, application, upcoming };
  }

  it('closes expired projects and rejects their pending applications with no read path involved', async () => {
    const { open, application, upcoming } = await scenario();

    await runJobs(atDaysFromNow(3));

    expect((await prisma.project.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('CLOSED');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('REJECTED');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: upcoming.id } })).status).toBe('OPEN');
  });

  it('evaluates the sweep at the job\'s now, not the wall clock', async () => {
    const { open, upcoming } = await scenario();

    await runJobs(atDaysFromNow(0.5));

    expect((await prisma.project.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('OPEN');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: upcoming.id } })).status).toBe('UPCOMING');
  });
});

describe('maintenance.cleanup', () => {
  it('drops finished jobs older than 14 days and expired rate-limit counters, keeping FAILED jobs', async () => {
    const now = atDaysFromNow(15);
    const oldSucceeded = await makeJob({ type: 'project.lifecycleSweep', status: 'SUCCEEDED' });
    const oldCancelled = await makeJob({ type: 'project.lifecycleSweep', status: 'CANCELLED' });
    const oldFailed = await makeJob({ type: 'project.lifecycleSweep', status: 'FAILED' });
    const recent = await makeJob({ type: 'project.lifecycleSweep', status: 'SUCCEEDED', updatedAt: atDaysFromNow(10) });
    const pending = await makeJob({ type: 'project.lifecycleSweep', runAt: atDaysFromNow(30) });
    await prisma.rateLimitCounter.createMany({
      data: [
        { key: 'expired', windowStart: atDaysFromNow(14), count: 3, expiresAt: atDaysFromNow(14.5) },
        { key: 'live', windowStart: atDaysFromNow(14.9), count: 3, expiresAt: atDaysFromNow(15.1) },
      ],
    });
    await enqueueJob(prisma, { type: 'maintenance.cleanup', runAt: new Date() });

    await runDueJobs({ now, types: ['maintenance.cleanup'] });

    const remaining = new Set((await prisma.job.findMany({ select: { id: true } })).map((job) => job.id));
    expect(remaining.has(oldSucceeded.id)).toBe(false);
    expect(remaining.has(oldCancelled.id)).toBe(false);
    expect(remaining.has(oldFailed.id)).toBe(true);
    expect(remaining.has(recent.id)).toBe(true);
    expect(remaining.has(pending.id)).toBe(true);
    expect((await prisma.rateLimitCounter.findMany()).map((row) => row.key)).toEqual(['live']);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/internal/jobs/run
// ---------------------------------------------------------------------------------------------

describe('POST /api/internal/jobs/run', () => {
  const TOKEN = 'internal-test-token';

  describe('with INTERNAL_JOB_TOKEN unset', () => {
    it('does not exist: answers exactly like an unmatched path', async () => {
      const res = await api().post('/api/internal/jobs/run').set('X-Internal-Token', TOKEN).send({});
      const unmatched = await api().post('/api/internal/jobs/nope').send({});

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toBe(unmatched.headers['content-type']);
      expect(res.text).toBe(unmatched.text.replace('/api/internal/jobs/nope', '/api/internal/jobs/run'));
      expect(await prisma.job.count()).toBe(0);
    });
  });

  describe('with INTERNAL_JOB_TOKEN set', () => {
    beforeEach(() => {
      process.env.INTERNAL_JOB_TOKEN = TOKEN;
    });

    afterEach(() => {
      process.env.INTERNAL_JOB_TOKEN = '';
    });

    it.each([
      ['missing', undefined],
      ['wrong, same length', 'x'.repeat(TOKEN.length)],
      ['wrong, shorter', 'short'],
      ['wrong, much longer', 'y'.repeat(500)],
    ])('a %s token → 403, never 500', async (_label, token) => {
      let req = api().post('/api/internal/jobs/run');
      if (token !== undefined) req = req.set('X-Internal-Token', token);
      const res = await req.send({});

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: 'Invalid internal token' } });
      expect(await prisma.job.count()).toBe(0);
    });

    it('checks the token before validating the body', async () => {
      const res = await api().post('/api/internal/jobs/run').set('X-Internal-Token', 'nope').send({ limit: 'x' });

      expect(res.status).toBe(403);
    });

    it.each([
      [{ limit: '5' }],
      [{ limit: 0 }],
      [{ limit: 501 }],
      [{ limit: 1.5 }],
    ])('rejects body %j with a rule-12 400', async (body) => {
      const res = await api().post('/api/internal/jobs/run').set('X-Internal-Token', TOKEN).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/^limit: /);
    });

    it('ensures recurring jobs, recovers stale ones and runs what is due', async () => {
      const handler = vi.spyOn(registry, TYPE).mockImplementation(async () => undefined);
      const due = await makeJob({ dedupeKey: 'due-now' });
      const stale = await makeJob({
        dedupeKey: 'stale', status: 'RUNNING', attempts: 1, lockedBy: 'dead',
        lockedAt: new Date(Date.now() - STALE_LOCK_MS - 60_000),
      });

      const res = await api()
        .post('/api/internal/jobs/run')
        .set('X-Internal-Token', TOKEN)
        .set('Authorization', 'Bearer not-a-jwt')
        .set('X-Request-Id', 'scheduler-run-1')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ claimed: 2, succeeded: 2, retried: 0, failed: 0, skipped: 0 });
      expect(handler).toHaveBeenCalledTimes(2);
      expect((await reload(due)).status).toBe('SUCCEEDED');
      expect(await reload(stale)).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });

      // The recurring slots were enqueued by this request, so they carry its id.
      const [sweep] = await jobsOf('project.lifecycleSweep');
      expect(sweep).toMatchObject({ status: 'PENDING', traceId: 'scheduler-run-1' });
    });

    it('honours limit', async () => {
      spyHandler();
      await Promise.all(Array.from({ length: 3 }, () => makeJob()));

      const res = await api().post('/api/internal/jobs/run').set('X-Internal-Token', TOKEN).send({ limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.claimed).toBe(2);
    });
  });
});
