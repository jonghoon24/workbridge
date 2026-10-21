import { describe, expect, it } from 'vitest';

import { prisma } from './helpers/db';
import { makeClient, makeFreelancer } from './helpers/factories';
import { notify, notifyMany } from '../src/lib/notifications/notify';

/** `notify()` — the Phase 0 minimum: in-app rows only, inside the caller's transaction. */

describe('notify / notifyMany', () => {
  it('creates an in-app notification', async () => {
    const user = await makeFreelancer();

    const created = await notify(prisma, {
      userId: user.id,
      type: 'APPLICATION_ACCEPTED',
      title: '제목',
      message: '본문',
      href: '/contracts/1',
    });

    expect(created).toMatchObject({ userId: user.id, type: 'APPLICATION_ACCEPTED', href: '/contracts/1', readAt: null });
  });

  it('defaults href to null and writes one row per recipient', async () => {
    const a = await makeFreelancer();
    const b = await makeClient();

    const count = await notifyMany(prisma, [
      { userId: a.id, type: 'PROJECT_STATUS_CHANGED', title: 't', message: 'm' },
      { userId: b.id, type: 'PROJECT_STATUS_CHANGED', title: 't', message: 'm' },
    ]);

    expect(count).toBe(2);
    expect(await prisma.notification.count({ where: { href: null } })).toBe(2);
    expect(await notifyMany(prisma, [])).toBe(0);
  });

  it('rolls back with the caller\'s transaction', async () => {
    const user = await makeFreelancer();

    await expect(prisma.$transaction(async (tx) => {
      await notify(tx, { userId: user.id, type: 'APPLICATION_REJECTED', title: 't', message: 'm' });
      throw new Error('state change failed');
    })).rejects.toThrow('state change failed');

    expect(await prisma.notification.count()).toBe(0);
  });
});
