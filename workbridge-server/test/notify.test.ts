import { describe, expect, it } from 'vitest';

import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeNotificationPreference } from './helpers/factories';
import { jobsOf } from './helpers/jobs';
import { notify, notifyMany, notifyRecipients } from '../src/lib/notifications/notify';

/**
 * `notify()` / `notifyMany()` / `notifyRecipients()` — their signatures and behavior inside
 * the caller's transaction. Channel decisions are covered in notification-policy.test.ts, the
 * email side in email.test.ts.
 */

describe('notify / notifyMany', () => {
  it('creates an in-app notification and returns it', async () => {
    const user = await makeFreelancer();

    const created = await notify(prisma, {
      userId: user.id,
      type: 'APPLICATION_ACCEPTED',
      title: '제목',
      message: '본문',
      href: '/contracts/1',
    });

    expect(created).toMatchObject({ userId: user.id, type: 'APPLICATION_ACCEPTED', href: '/contracts/1', readAt: null });
    expect(await prisma.notification.count()).toBe(1);
  });

  it('returns null when in-app is off for the recipient, and writes no in-app row', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'APPLICATION_REJECTED', { inApp: false });

    const created = await notify(prisma, { userId: user.id, type: 'APPLICATION_REJECTED', title: 't', message: 'm' });

    expect(created).toBeNull();
    expect(await prisma.notification.count()).toBe(0);
  });

  it('defaults href to null and returns the number of in-app rows written', async () => {
    const a = await makeFreelancer();
    const b = await makeClient();
    const c = await makeFreelancer();
    await makeNotificationPreference(c.id, 'PROJECT_STATUS_CHANGED', { inApp: false });

    const count = await notifyMany(prisma, [
      { userId: a.id, type: 'PROJECT_STATUS_CHANGED', title: 't', message: 'm' },
      { userId: b.id, type: 'PROJECT_STATUS_CHANGED', title: 't', message: 'm' },
      { userId: c.id, type: 'PROJECT_STATUS_CHANGED', title: 't', message: 'm' },
    ]);

    expect(count).toBe(2);
    expect(await prisma.notification.count({ where: { href: null } })).toBe(2);
    expect(await notifyMany(prisma, [])).toBe(0);
  });

  it('links each email delivery to its own in-app row', async () => {
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    const now = new Date('2026-05-01T00:00:00.000Z');

    await notifyMany(prisma, [
      { userId: a.id, type: 'MILESTONE_FUNDED', title: 't', message: 'a' },
      { userId: b.id, type: 'MILESTONE_FUNDED', title: 't', message: 'b' },
    ], now);

    const deliveries = await prisma.emailDelivery.findMany({ include: { notification: true } });
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      expect(delivery.notification?.userId).toBe(delivery.userId);
      expect(delivery.createdAt.getTime()).toBe(now.getTime());
    }
    expect((await jobsOf('notification.email')).map((j) => j.runAt.getTime())).toEqual([now.getTime(), now.getTime()]);
  });

  it('notifyRecipients skips soft-deleted recipients entirely and passes `now` through', async () => {
    const active = await makeFreelancer();
    const deleted = await makeFreelancer({ deletedAt: new Date() });
    const now = new Date('2026-05-02T00:00:00.000Z');

    const count = await notifyRecipients(prisma, [active, deleted], { type: 'MILESTONE_FUNDED', title: 't', message: 'm' }, now);

    expect(count).toBe(1);
    expect(await prisma.notification.findMany({ select: { userId: true } })).toEqual([{ userId: active.id }]);
    const [delivery] = await prisma.emailDelivery.findMany();
    expect(delivery).toMatchObject({ userId: active.id, createdAt: now });
  });

  it('rolls back with the caller\'s transaction: no row, no delivery, no job', async () => {
    const user = await makeFreelancer();

    await expect(prisma.$transaction(async (tx) => {
      await notify(tx, { userId: user.id, type: 'APPLICATION_ACCEPTED', title: 't', message: 'm' });
      throw new Error('state change failed');
    })).rejects.toThrow('state change failed');

    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.emailDelivery.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });
});
