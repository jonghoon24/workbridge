import { describe, expect, it } from 'vitest';
import type { Notification, Prisma, User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer } from './helpers/factories';
import { renderTemplate } from '../src/lib/notifications/templates';

/**
 * Local factory — there is no notification factory in `test/helpers`, and every test here
 * needs to control `userId`, `readAt`, and `createdAt` precisely.
 */
function makeNotification(
  userId: string,
  overrides: Partial<Prisma.NotificationUncheckedCreateInput> = {},
): Promise<Notification> {
  return prisma.notification.create({
    data: {
      userId,
      type: 'APPLICATION_CREATED',
      title: '새 지원자가 있습니다',
      message: '프로젝트에 새로운 지원이 접수되었습니다.',
      ...overrides,
    },
  });
}

/** `count` notifications for `userId` with strictly increasing `createdAt`, oldest first. */
async function seedNotifications(
  userId: string,
  count: number,
  overrides: Partial<Prisma.NotificationUncheckedCreateInput> = {},
): Promise<void> {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  await prisma.notification.createMany({
    data: Array.from({ length: count }, (_unused, i) => ({
      userId,
      type: 'APPLICATION_CREATED',
      title: `제목 ${i}`,
      message: `메시지 ${i}`,
      createdAt: new Date(base + i * 60_000),
      ...overrides,
    })),
  });
}

/** Two users whose notifications must never leak into each other's responses. */
async function twoUsers(): Promise<{ caller: User; other: User }> {
  const caller = await makeClient();
  const other = await makeFreelancer();
  return { caller, other };
}

describe('GET /api/notifications', () => {
  it('returns an empty list and a zero unread count for a user with none', async () => {
    const caller = await makeClient();

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('returns the caller notifications newest first', async () => {
    const caller = await makeClient();
    await makeNotification(caller.id, {
      title: 'oldest',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await makeNotification(caller.id, {
      title: 'middle',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await makeNotification(caller.id, {
      title: 'newest',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { title: string }) => n.title)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('returns the full notification shape', async () => {
    const caller = await makeClient();
    const created = await makeNotification(caller.id, {
      type: 'APPLICATION_ACCEPTED',
      title: '지원이 수락되었습니다',
      message: '계약서를 확인해주세요.',
      href: '/contracts/abc',
    });

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      id: created.id,
      userId: caller.id,
      type: 'APPLICATION_ACCEPTED',
      title: '지원이 수락되었습니다',
      message: '계약서를 확인해주세요.',
      href: '/contracts/abc',
      readAt: null,
    });
    expect(res.body.notifications[0].createdAt).toEqual(expect.any(String));
  });

  it('defaults limit to 20', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 25);

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(20);
    expect(res.body.unreadCount).toBe(25);
  });

  it('honours an explicit limit below the default', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 10);

    const res = await authed(caller).get('/api/notifications?limit=3');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(3);
    // Still newest first: seeds ascend in time, so the last three seeded come back reversed.
    expect(res.body.notifications.map((n: { title: string }) => n.title)).toEqual([
      '제목 9',
      '제목 8',
      '제목 7',
    ]);
  });

  it('caps limit at 50', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 55);

    const res = await authed(caller).get('/api/notifications?limit=1000');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(50);
    expect(res.body.unreadCount).toBe(55);
  });

  it('accepts limit=50 exactly', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 55);

    const res = await authed(caller).get('/api/notifications?limit=50');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(50);
  });

  it('accepts limit=1', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 4);

    const res = await authed(caller).get('/api/notifications?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].title).toBe('제목 3');
  });

  it.each(['0', '-1', '-50', 'abc', 'null', 'NaN', 'Infinity'])(
    'rejects limit=%s with 400',
    async (limit) => {
      const caller = await makeClient();
      await seedNotifications(caller.id, 2);

      const res = await authed(caller).get(`/api/notifications?limit=${limit}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'limit must be a positive integer' } });
    },
  );

  it('falls back to the default when limit is present but empty', async () => {
    // `value || '20'` treats an empty string as absent, so `?limit=` is the documented default.
    const caller = await makeClient();
    await seedNotifications(caller.id, 25);

    const res = await authed(caller).get('/api/notifications?limit=');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(20);
  });

  // Untagged divergence: the spec says a non-integer limit must be 400, but `Number.parseInt`
  // truncates "1.5" to 1, so the request succeeds with one row instead of erroring.
  it.fails('rejects a fractional limit with 400', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 4);

    const res = await authed(caller).get('/api/notifications?limit=1.5');

    expect(res.status).toBe(400);
  });

  // Untagged divergence, same root cause: "20abc" parses to 20 rather than being rejected.
  it.fails('rejects a trailing-garbage limit with 400', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 4);

    const res = await authed(caller).get('/api/notifications?limit=3abc');

    expect(res.status).toBe(400);
  });

  it('takes the leading number from a repeated limit (Q12)', async () => {
    // qs parses `?limit=1&limit=2` into `['1', '2']`; `Number.parseInt` stringifies that to
    // '1,2' and stops at the comma, so the request succeeds with limit 1 — neither the
    // documented default of 20 nor a 400. `GET /api/projects` deliberately falls back to its
    // default in the same situation, so the two endpoints disagree. Pinned, not endorsed.
    const caller = await makeClient();
    await seedNotifications(caller.id, 25);

    const res = await authed(caller).get('/api/notifications?limit=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.unreadCount).toBe(25);
  });

  it('is order-dependent for a repeated limit — the first value wins (Q12)', async () => {
    // Same mechanism, reversed: '2,1' parses to 2. Confirms the value is read from the leading
    // number rather than, say, the last occurrence.
    const caller = await makeClient();
    await seedNotifications(caller.id, 25);

    const res = await authed(caller).get('/api/notifications?limit=2&limit=1');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
  });

  it('counts every unread notification, not just the page returned', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 30);

    const res = await authed(caller).get('/api/notifications?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(5);
    expect(res.body.unreadCount).toBe(30);
  });

  it('excludes read notifications from unreadCount but still lists them', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 3, { readAt: new Date('2026-05-01T00:00:00.000Z') });
    await seedNotifications(caller.id, 2);

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(5);
    expect(res.body.unreadCount).toBe(2);
  });

  it('does not count another user unread notifications', async () => {
    const { caller, other } = await twoUsers();
    await seedNotifications(caller.id, 2);
    await seedNotifications(other.id, 7);

    const res = await authed(caller).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns 0 when the caller has no notifications', async () => {
    const caller = await makeClient();

    const res = await authed(caller).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0 });
  });

  it('counts only the caller unread notifications', async () => {
    const { caller, other } = await twoUsers();
    await seedNotifications(caller.id, 4);
    await seedNotifications(caller.id, 2, { readAt: new Date('2026-05-01T00:00:00.000Z') });
    await seedNotifications(other.id, 9);

    const res = await authed(caller).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 4 });
  });

  it('reports 0 for a caller when only another user has unread notifications', async () => {
    const { caller, other } = await twoUsers();
    await seedNotifications(other.id, 6);

    const res = await authed(caller).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0 });
  });
});

describe('PATCH /api/notifications/:id/read', () => {
  it('marks the caller notification read and persists readAt', async () => {
    const caller = await makeClient();
    const notification = await makeNotification(caller.id);

    const res = await authed(caller).patch(`/api/notifications/${notification.id}/read`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(notification.id);
    expect(res.body.readAt).toEqual(expect.any(String));

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(stored.readAt).not.toBeNull();
    expect(stored.readAt!.toISOString()).toBe(res.body.readAt);
  });

  it('leaves the caller other notifications untouched', async () => {
    const caller = await makeClient();
    const target = await makeNotification(caller.id, { title: 'target' });
    const bystander = await makeNotification(caller.id, { title: 'bystander' });

    await authed(caller).patch(`/api/notifications/${target.id}/read`);

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(stored.readAt).toBeNull();
  });

  it('is idempotent — re-reading preserves the stored readAt', async () => {
    const caller = await makeClient();
    const notification = await makeNotification(caller.id);

    const first = await authed(caller).patch(`/api/notifications/${notification.id}/read`);
    const afterFirst = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });

    expect(first.status).toBe(200);
    expect(afterFirst.readAt).not.toBeNull();

    // Rewind the stamp the first call wrote to a fixed instant an hour in the past. The handler
    // cannot tell how `readAt` got there, so this is the same guarantee as calling twice back to
    // back — but a re-stamp would use `new Date()`, which is necessarily later, so the regression
    // is detectable without sleeping to open a wall-clock gap.
    const rewound = new Date(Date.now() - 3_600_000);
    await prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: rewound },
    });
    // Sanity: the sentinel is distinguishable from anything the handler would write itself.
    expect(afterFirst.readAt!.toISOString()).not.toBe(rewound.toISOString());

    const second = await authed(caller).patch(`/api/notifications/${notification.id}/read`);
    const afterSecond = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });

    expect(second.status).toBe(200);
    expect(second.body.readAt).toBe(rewound.toISOString());
    expect(afterSecond.readAt!.toISOString()).toBe(rewound.toISOString());
  });

  it('preserves a readAt that was already set before the request', async () => {
    const caller = await makeClient();
    const readAt = new Date('2026-04-01T09:30:00.000Z');
    const notification = await makeNotification(caller.id, { readAt });

    const res = await authed(caller).patch(`/api/notifications/${notification.id}/read`);

    expect(res.status).toBe(200);
    expect(res.body.readAt).toBe(readAt.toISOString());

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(stored.readAt!.toISOString()).toBe(readAt.toISOString());
  });
});

describe('PATCH /api/notifications/read-all', () => {
  it('marks every unread notification of the caller read', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 4);

    const res = await authed(caller).patch('/api/notifications/read-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Notifications marked as read' });
    expect(
      await prisma.notification.count({ where: { userId: caller.id, readAt: null } }),
    ).toBe(0);
    expect(
      await prisma.notification.count({ where: { userId: caller.id, readAt: { not: null } } }),
    ).toBe(4);
  });

  it('succeeds when the caller has nothing unread', async () => {
    const caller = await makeClient();

    const res = await authed(caller).patch('/api/notifications/read-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Notifications marked as read' });
  });

  it('does not touch another user notifications', async () => {
    const { caller, other } = await twoUsers();
    await seedNotifications(caller.id, 3);
    await seedNotifications(other.id, 5);

    const res = await authed(caller).patch('/api/notifications/read-all');

    expect(res.status).toBe(200);
    expect(
      await prisma.notification.count({ where: { userId: caller.id, readAt: null } }),
    ).toBe(0);
    expect(
      await prisma.notification.count({ where: { userId: other.id, readAt: null } }),
    ).toBe(5);
  });

  it('leaves already-read notifications with their original timestamps', async () => {
    const caller = await makeClient();
    const originalReadAt = new Date('2026-04-01T09:30:00.000Z');
    const alreadyRead = await makeNotification(caller.id, {
      title: 'already read',
      readAt: originalReadAt,
    });
    const unread = await makeNotification(caller.id, { title: 'unread' });

    // Bracket the request instead of comparing against the fixture date: `readAt` for the newly
    // read row is stamped with `new Date()` in-process, so it must land inside this window. The
    // fixture comparison only held because wall-clock happens to be past 2026-04-01.
    const before = new Date();
    const res = await authed(caller).patch('/api/notifications/read-all');
    const after = new Date();

    expect(res.status).toBe(200);

    const storedRead = await prisma.notification.findUniqueOrThrow({
      where: { id: alreadyRead.id },
    });
    const storedUnread = await prisma.notification.findUniqueOrThrow({ where: { id: unread.id } });

    expect(storedRead.readAt!.toISOString()).toBe(originalReadAt.toISOString());
    expect(storedUnread.readAt).not.toBeNull();
    expect(storedUnread.readAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(storedUnread.readAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('is idempotent — a second call preserves the timestamps already stored', async () => {
    const caller = await makeClient();
    await seedNotifications(caller.id, 3);

    const first = await authed(caller).patch('/api/notifications/read-all');
    const afterFirst = await prisma.notification.findMany({
      where: { userId: caller.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(first.status).toBe(200);
    expect(afterFirst).toHaveLength(3);
    expect(afterFirst.every((n) => n.readAt !== null)).toBe(true);

    // Same reasoning as the single-notification idempotency test: rewind the stamps the first
    // call wrote to a fixed past instant rather than sleeping. `updateMany` only matches
    // `readAt: null`, so the second call must leave these alone; if it re-stamped them they
    // would jump to `new Date()`, an hour later.
    const rewound = new Date(Date.now() - 3_600_000);
    await prisma.notification.updateMany({
      where: { userId: caller.id },
      data: { readAt: rewound },
    });

    const second = await authed(caller).patch('/api/notifications/read-all');
    const afterSecond = await prisma.notification.findMany({
      where: { userId: caller.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(second.status).toBe(200);
    expect(afterSecond.map((n) => n.readAt!.toISOString())).toEqual(
      Array.from({ length: 3 }, () => rewound.toISOString()),
    );
  });
});

describe('Phase 1 notification types [C9]', () => {
  it('renders all 15 new types with the links BEHAVIOR.md lists', () => {
    const v = { projectTitle: 'P', contractId: 'c1', milestoneId: 'm1', milestoneTitle: 'M', settlementId: 's1', amount: 1_000, reason: 'r' };
    const milestone = '/contracts/c1/milestones/m1';
    const expected: Record<string, string> = {
      CONTRACT_ACTIVATED: '/contracts/c1',
      MILESTONE_PLAN_UPDATED: '/contracts/c1',
      MILESTONE_FUNDED: milestone,
      MILESTONE_SUBMITTED: milestone,
      MILESTONE_REVISION_REQUESTED: milestone,
      MILESTONE_APPROVED: milestone,
      MILESTONE_AUTO_APPROVED: milestone,
      MILESTONE_AUTO_APPROVE_REMINDER: milestone,
      MILESTONE_DUE_SOON: milestone,
      MILESTONE_OVERDUE: milestone,
      CONTRACT_COMPLETED: '/contracts/c1#review',
      SETTLEMENT_SCHEDULED: '/settlements/s1',
      SETTLEMENT_PAID: '/settlements/s1',
      SETTLEMENT_ON_HOLD: '/settlements/account',
      SETTLEMENT_FAILED: '/settlements/s1',
    };
    expect(Object.keys(expected)).toHaveLength(15);
    for (const [type, href] of Object.entries(expected)) {
      const rendered = renderTemplate(type as Parameters<typeof renderTemplate>[0], v);
      expect(rendered.href, type).toBe(href);
      expect(rendered.title.length, type).toBeGreaterThan(0);
      expect(rendered.message.length, type).toBeGreaterThan(0);
    }
  });
});
