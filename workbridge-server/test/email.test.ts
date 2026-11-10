import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeContractScenario,
  makeFreelancer,
  makeNotificationPreference,
  makePayment,
} from './helpers/factories';
import { jobsOf, runJobs } from './helpers/jobs';
import { enqueueJob } from '../src/jobs/queue';
import { notify } from '../src/lib/notifications/notify';
import { LogMailProvider, setMailProvider } from '../src/lib/mail/provider';
import type { MailMessage, MailProvider } from '../src/lib/mail/provider';

/**
 * Email delivery: which deliveries `notify()` creates, the `notification.email` handler, the
 * mail provider, and the transaction of the auto-approval reminder, due-soon and overdue notices.
 * Email wording is never asserted.
 */

const T0 = new Date('2026-06-01T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Records every send; throws while `failures` > 0. */
class RecordingProvider implements MailProvider {
  sent: MailMessage[] = [];
  calls = 0;
  constructor(public failures = 0) {}
  async send(message: MailMessage) {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('smtp timeout');
    }
    this.sent.push(message);
    return { providerMessageId: `rec-${this.calls}` };
  }
}

let provider: RecordingProvider;
let previous: MailProvider;
const savedEnv = {
  MAIL_PROVIDER: process.env.MAIL_PROVIDER,
  MAIL_FROM: process.env.MAIL_FROM,
  LOG_LEVEL: process.env.LOG_LEVEL,
  CLIENT_URL: process.env.CLIENT_URL,
  JOB_EMAIL_ENABLED: process.env.JOB_EMAIL_ENABLED,
};

beforeEach(() => {
  provider = new RecordingProvider();
  previous = setMailProvider(provider);
});

afterEach(() => {
  setMailProvider(previous);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

/** A freelancer with one email-on notification created at `T0` (MILESTONE_DUE_SOON: in-app + email). */
async function oneDelivery() {
  const user = await makeFreelancer();
  const notification = await notify(prisma, {
    userId: user.id,
    type: 'MILESTONE_DUE_SOON',
    title: '마일스톤 기한',
    message: '본문',
    href: '/contracts/c/milestones/m',
  }, T0);
  const delivery = await prisma.emailDelivery.findFirstOrThrow();
  return { user, notification, delivery };
}

const deliveryOf = (id: string) => prisma.emailDelivery.findUniqueOrThrow({ where: { id } });

describe('notification.email behind JOB_EMAIL_ENABLED', () => {
  it.each([['unset', undefined], ['false', 'false']])(
    'with the flag %s, the delivery is SKIPPED without a provider call and the job SUCCEEDS',
    async (_label, value) => {
      if (value === undefined) delete process.env.JOB_EMAIL_ENABLED;
      else process.env.JOB_EMAIL_ENABLED = value;
      const { delivery } = await oneDelivery();

      const result = await runJobs(T0);

      expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(provider.calls).toBe(0);
      expect(await deliveryOf(delivery.id)).toMatchObject({
        status: 'SKIPPED',
        error: 'Email sending is disabled (JOB_EMAIL_ENABLED)',
        attempts: 0,
        sentAt: null,
      });
      expect((await jobsOf('notification.email'))[0].status).toBe('SUCCEEDED');
    },
  );

  it('turning the flag on later sends only new emails, never the skipped backlog', async () => {
    process.env.JOB_EMAIL_ENABLED = 'false';
    const { user, delivery: old } = await oneDelivery();
    await runJobs(T0);

    process.env.JOB_EMAIL_ENABLED = 'true';
    await notify(prisma, {
      userId: user.id,
      type: 'MILESTONE_DUE_SOON',
      title: '새 알림',
      message: '본문',
      href: '/contracts/c/milestones/m2',
    }, new Date(T0.getTime() + HOUR));
    await runJobs(new Date(T0.getTime() + HOUR));

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].deliveryId).not.toBe(old.id);
    expect((await deliveryOf(old.id)).status).toBe('SKIPPED');
    expect(await prisma.emailDelivery.count({ where: { status: 'SENT' } })).toBe(1);
  });
});
const quietErrors = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('notify() creates the delivery and its job', () => {
  it('PENDING, attempts 0, createdAt = now, linked to the in-app row, address snapshotted', async () => {
    const { user, notification, delivery } = await oneDelivery();

    expect(delivery).toMatchObject({
      userId: user.id,
      type: 'MILESTONE_DUE_SOON',
      toAddress: user.email,
      contextKey: null,
      status: 'PENDING',
      attempts: 0,
      provider: null,
      providerMessageId: null,
      error: null,
      sentAt: null,
      notificationId: notification!.id,
    });
    expect(delivery.createdAt.getTime()).toBe(T0.getTime());
    expect(delivery.subject.length).toBeGreaterThan(0);
    expect(delivery.body.length).toBeGreaterThan(0);
  });

  it('enqueues notification.email with payload { deliveryId }, its dedupe key and runAt = now', async () => {
    const { delivery } = await oneDelivery();

    const [job] = await jobsOf('notification.email');
    expect(job).toMatchObject({
      status: 'PENDING',
      payload: { deliveryId: delivery.id },
      dedupeKey: `notification.email:${delivery.id}`,
      maxAttempts: 5,
    });
    expect(job.runAt.getTime()).toBe(T0.getTime());
  });

  it('links use CLIENT_URL, trimmed and without a trailing slash', async () => {
    process.env.CLIENT_URL = ' http://a.test/ ';

    const { delivery } = await oneDelivery();

    expect(delivery.body).toContain('http://a.test/my/notifications/settings');
    expect(delivery.body).toContain('http://a.test/contracts/c/milestones/m');
  });

  // No link to a guessed address: the delivery records why it was not sent, the cause still commits.
  it.each([
    ['unset', undefined, 'CLIENT_URL is not set'],
    ['a comma-separated list', 'http://a.test, http://b.test', 'CLIENT_URL must be a single origin'],
  ])('with CLIENT_URL %s, the delivery is FAILED with the reason and gets no job; the notification stays', async (_label, value, reason) => {
    if (value === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = value;

    const { delivery } = await oneDelivery();

    expect(await prisma.notification.count()).toBe(1);
    expect(delivery).toMatchObject({ status: 'FAILED', attempts: 0, sentAt: null });
    expect(delivery.error).toContain(reason);
    expect(delivery.body).not.toMatch(/undefined|localhost/);
    expect(await jobsOf('notification.email')).toHaveLength(0);
  });

  it('with CLIENT_URL unset, notify() writes one warn line naming it', async () => {
    delete process.env.CLIENT_URL;
    process.env.LOG_LEVEL = 'warn';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await oneDelivery();

    const warns = out.mock.calls.map(([line]) => JSON.parse(String(line))).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].error).toBe('CLIENT_URL is not set');
  });

  it('carries no unsubscribe link or token; the last line is the sign-in preferences page', async () => {
    const { delivery } = await oneDelivery();

    expect(delivery.body).not.toMatch(/unsubscribe|token=/i);
    expect(delivery.body.trimEnd().split('\n').at(-1)).toMatch(/\/my\/notifications\/settings$/);
  });

  it('creates no delivery for a recipient without an address', async () => {
    const user = await makeFreelancer({ email: '   ' });

    await notify(prisma, { userId: user.id, type: 'MILESTONE_DUE_SOON', title: 't', message: 'm' }, T0);

    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.emailDelivery.count()).toBe(0);
  });

  it('creates no delivery for a soft-deleted recipient, whatever the type', async () => {
    const user = await makeFreelancer({ deletedAt: new Date() });

    await notify(prisma, { userId: user.id, type: 'SETTLEMENT_FAILED', title: 't', message: 'm' }, T0);

    expect(await prisma.emailDelivery.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('a submission writes the client\'s delivery and job in its own transaction', async () => {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED', fundedAt: new Date() },
    });
    await makePayment(scenario.milestone.id, scenario.client.id, { status: 'COMPLETED' });

    const res = await authed(scenario.freelancer)
      .post(`/api/milestones/${scenario.milestone.id}/submissions`)
      .send({ message: '산출물' });

    expect(res.status).toBe(201);
    const [delivery] = await prisma.emailDelivery.findMany();
    const [notification] = await prisma.notification.findMany();
    expect(delivery).toMatchObject({ userId: scenario.client.id, type: 'MILESTONE_SUBMITTED', notificationId: notification.id });
    expect((await jobsOf('notification.email')).map((j) => j.payload)).toEqual([{ deliveryId: delivery.id }]);
  });
});

describe('notification.email', () => {
  it('sends: SENT, attempts 1, sentAt = the job\'s now, provider and id recorded; no extra headers', async () => {
    const { user, delivery } = await oneDelivery();
    process.env.MAIL_FROM = 'WorkBridge <mail@test.local>';
    const runAt = new Date(T0.getTime() + 5 * MINUTE);

    const result = await runJobs(runAt);

    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
    const sent = await deliveryOf(delivery.id);
    expect(sent).toMatchObject({ status: 'SENT', attempts: 1, provider: 'log', providerMessageId: 'rec-1', error: null });
    expect(sent.sentAt?.getTime()).toBe(runAt.getTime());
    expect(provider.sent).toEqual([{
      deliveryId: delivery.id,
      from: 'WorkBridge <mail@test.local>',
      to: user.email,
      subject: delivery.subject,
      text: delivery.body,
    }]);
  });

  it('uses MAIL_FROM\'s default sender when unset', async () => {
    await oneDelivery();
    delete process.env.MAIL_FROM;

    await runJobs(T0);

    expect(provider.sent[0].from).toBe('WorkBridge <no-reply@workbridge.local>');
  });

  it('sends to the address snapshotted at creation, and sends even after the email was turned off', async () => {
    const { user, delivery } = await oneDelivery();
    await prisma.user.update({ where: { id: user.id }, data: { email: 'changed@test.local' } });
    await makeNotificationPreference(user.id, 'MILESTONE_DUE_SOON', { email: false });

    await runJobs(T0);

    expect((await deliveryOf(delivery.id)).status).toBe('SENT');
    expect(provider.sent.map((m) => m.to)).toEqual([delivery.toAddress]);
  });

  it('a recipient soft-deleted after creation → SKIPPED without a provider call; the job succeeds', async () => {
    const { user, delivery } = await oneDelivery();
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

    const result = await runJobs(T0);

    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'SKIPPED', error: 'Recipient is no longer active', attempts: 0, provider: null });
    expect(provider.calls).toBe(0);
  });

  it('a delivery no longer PENDING is a no-op', async () => {
    const { delivery } = await oneDelivery();
    await prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT' } });

    const result = await runJobs(T0);

    expect(result).toMatchObject({ succeeded: 1 });
    expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'SENT', attempts: 0 });
    expect(provider.calls).toBe(0);
  });

  it('a payload naming no delivery fails permanently', async () => {
    await enqueueJob(prisma, { type: 'notification.email', payload: { deliveryId: 'missing-delivery' }, runAt: T0 });
    const errors = quietErrors();

    const result = await runJobs(T0);

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    const [job] = await jobsOf('notification.email');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('a provider failure with attempts left keeps PENDING, records error and provider, and retries with backoff', async () => {
    const { delivery } = await oneDelivery();
    provider.failures = 1;

    const first = await runJobs(T0);

    expect(first).toMatchObject({ retried: 1 });
    expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'PENDING', attempts: 1, provider: 'log', error: 'smtp timeout' });
    const [job] = await jobsOf('notification.email');
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(job.runAt.getTime()).toBe(T0.getTime() + 30_000);

    await runJobs(job.runAt);

    expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'SENT', attempts: 2, error: null, providerMessageId: 'rec-2' });
  });

  it('the provider failing on the job\'s last attempt → FAILED with its error; nothing sends it again', async () => {
    const { delivery } = await oneDelivery();
    provider.failures = 99;
    const errors = quietErrors();

    let now = T0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runJobs(now);
      now = new Date(now.getTime() + 2 * HOUR);
    }
    await runJobs(now);

    expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'FAILED', attempts: 5, provider: 'log', error: 'smtp timeout' });
    const [job] = await jobsOf('notification.email');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(provider.calls).toBe(5);
    expect(errors).toHaveBeenCalledTimes(1); // the queue's `job failed` line only
  });

  it('stores at most 2,000 characters of a provider error', async () => {
    const { delivery } = await oneDelivery();
    setMailProvider({ send: async () => { throw new Error('x'.repeat(5000)); } });

    await runJobs(T0);

    expect((await deliveryOf(delivery.id)).error).toHaveLength(2000);
  });

  it('the project\'s soft deletion plays no part', async () => {
    const scenario = await makeContractScenario();
    await notify(prisma, { userId: scenario.freelancer.id, type: 'MILESTONE_FUNDED', title: 't', message: 'm' }, T0);
    await prisma.project.update({ where: { id: scenario.project.id }, data: { deletedAt: new Date() } });

    await runJobs(T0);

    expect((await prisma.emailDelivery.findFirstOrThrow()).status).toBe('SENT');
  });
});

describe('mail provider', () => {
  it('an unsupported MAIL_PROVIDER → FAILED without a provider call or an attempt; the job fails without retry', async () => {
    const { delivery } = await oneDelivery();
    process.env.MAIL_PROVIDER = 'smtp';
    quietErrors();

    const result = await runJobs(T0);

    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(await deliveryOf(delivery.id)).toMatchObject({
      status: 'FAILED',
      attempts: 0,
      provider: 'smtp',
      error: 'Unsupported MAIL_PROVIDER "smtp"',
    });
    const [job] = await jobsOf('notification.email');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(job.lastError).toContain('Unsupported MAIL_PROVIDER "smtp"');
    expect(provider.calls).toBe(0);
  });

  it.each([['unset', undefined], ['empty', ''], ['log', 'log']])(
    'MAIL_PROVIDER %s → the log provider, recorded as `log`',
    async (_label, value) => {
      const { delivery } = await oneDelivery();
      if (value === undefined) delete process.env.MAIL_PROVIDER;
      else process.env.MAIL_PROVIDER = value;

      await runJobs(T0);

      expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'SENT', provider: 'log' });
    },
  );

  it('the log provider writes one info line `mail.sent` with the email and a `log-<uuid>` id', async () => {
    setMailProvider(new LogMailProvider());
    const { user, delivery } = await oneDelivery();
    process.env.LOG_LEVEL = 'info';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runJobs(T0);

    const lines = out.mock.calls.map(([line]) => JSON.parse(String(line)));
    const mail = lines.filter((line) => line.msg === 'mail.sent');
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      level: 'info',
      deliveryId: delivery.id,
      to: user.email,
      subject: delivery.subject,
      text: delivery.body,
      from: expect.any(String),
    });
    expect(mail[0].providerMessageId).toMatch(/^log-[0-9a-f-]{36}$/);
    expect((await deliveryOf(delivery.id)).providerMessageId).toBe(mail[0].providerMessageId);
  });

  it('an unsupported value is reported once per process as a warn line; a supported one is not', async () => {
    process.env.LOG_LEVEL = 'warn';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warned = () => out.mock.calls.map(([line]) => JSON.parse(String(line))).filter((l) => l.msg === 'unsupported MAIL_PROVIDER');

    process.env.MAIL_PROVIDER = 'log';
    vi.resetModules();
    (await import('../src/lib/mail/provider.js')).warnIfUnsupportedMailProvider();
    expect(warned()).toHaveLength(0);

    process.env.MAIL_PROVIDER = 'sendgrid';
    vi.resetModules();
    const fresh = await import('../src/lib/mail/provider.js');
    fresh.warnIfUnsupportedMailProvider();
    fresh.warnIfUnsupportedMailProvider();
    expect(warned()).toEqual([expect.objectContaining({ level: 'warn', mailProvider: 'sendgrid' })]);
  });
});

describe('auto-approval reminder, due-soon and overdue notices open a transaction and use ctx.now', () => {
  it('overdue: both parties get a delivery created at the job\'s now; the emails go out on a later pass', async () => {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED', fundedAt: new Date() },
    });
    await enqueueJob(prisma, { type: 'milestone.overdue', payload: { milestoneId: scenario.milestone.id }, runAt: T0 });
    const runAt = new Date(T0.getTime() + 3 * MINUTE);

    const first = await runJobs(runAt);

    expect(first).toMatchObject({ claimed: 1, succeeded: 1 });
    const deliveries = await prisma.emailDelivery.findMany({ orderBy: { userId: 'asc' } });
    expect(deliveries.map((d) => d.userId).sort()).toEqual([scenario.client.id, scenario.freelancer.id].sort());
    expect(deliveries.every((d) => d.createdAt.getTime() === runAt.getTime() && d.status === 'PENDING')).toBe(true);
    expect((await jobsOf('notification.email')).every((j) => j.runAt.getTime() === runAt.getTime())).toBe(true);

    const second = await runJobs(runAt);

    expect(second).toMatchObject({ claimed: 2, succeeded: 2 });
    expect((await prisma.emailDelivery.findMany()).map((d) => d.status)).toEqual(['SENT', 'SENT']);
  });

  it('a notice whose write fails leaves no partial rows, so its retry does not duplicate them', async () => {
    const scenario = await makeContractScenario({
      contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
      milestone: { status: 'FUNDED', fundedAt: new Date() },
    });
    await enqueueJob(prisma, { type: 'milestone.overdue', payload: { milestoneId: scenario.milestone.id }, runAt: T0 });
    // Inject a failure into the notice's email write: the whole notice must roll back.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION p3_fail_delivery() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER p3_fail_delivery BEFORE INSERT ON "EmailDelivery" FOR EACH STATEMENT EXECUTE FUNCTION p3_fail_delivery();',
    );
    try {
      const first = await runJobs(T0);
      expect(first).toMatchObject({ retried: 1 });
      expect(await prisma.notification.count()).toBe(0); // the in-app rows rolled back too
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS p3_fail_delivery ON "EmailDelivery";');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS p3_fail_delivery();');
    }

    const [job] = await jobsOf('milestone.overdue');
    await runJobs(job.runAt);

    expect(await prisma.notification.count()).toBe(2);
    expect(await prisma.emailDelivery.count()).toBe(2);
  });
});
