import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeNotificationPreference } from './helpers/factories';
import { notify } from '../src/lib/notifications/notify';

/**
 * `GET` / `PUT /api/notifications/preferences`. The 401 matrix lives in
 * authorization.test.ts and the soft-deleted caller in soft-delete.test.ts.
 */

const CLIENT_TYPES = [
  'APPLICATION_CREATED', 'CONTRACT_ACTIVATED', 'MILESTONE_SUBMITTED', 'MILESTONE_AUTO_APPROVED',
  'MILESTONE_AUTO_APPROVE_REMINDER', 'MILESTONE_OVERDUE', 'CONTRACT_COMPLETED', 'CONTRACT_CANCELLED',
  'MESSAGE_UNREAD_DIGEST',
];
const FREELANCER_TYPES = [
  'APPLICATION_ACCEPTED', 'APPLICATION_REJECTED', 'PROJECT_STATUS_CHANGED', 'CONTRACT_ACTIVATED',
  'MILESTONE_PLAN_UPDATED', 'MILESTONE_FUNDED', 'MILESTONE_REVISION_REQUESTED', 'MILESTONE_APPROVED',
  'MILESTONE_AUTO_APPROVED', 'MILESTONE_DUE_SOON', 'MILESTONE_OVERDUE', 'CONTRACT_COMPLETED', 'CONTRACT_CANCELLED',
  'SETTLEMENT_SCHEDULED', 'SETTLEMENT_PAID', 'SETTLEMENT_ON_HOLD', 'SETTLEMENT_FAILED', 'MESSAGE_UNREAD_DIGEST',
];

const get = (user: User) => authed(user).get('/api/notifications/preferences');
const put = (user: User, body: unknown) => authed(user).put('/api/notifications/preferences').send(body as object);
const entry = (res: { body: { preferences: { type: string }[] } }, type: string) =>
  res.body.preferences.find((p) => p.type === type);
const storedRows = (userId: string) =>
  prisma.notificationPreference.findMany({ where: { userId }, orderBy: { type: 'asc' }, select: { type: true, inApp: true, email: true } });

describe('GET /api/notifications/preferences', () => {
  it('a CLIENT gets its 9 types in notification-catalog order, with the defaults', async () => {
    const client = await makeClient();

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['preferences']);
    expect(res.body.preferences.map((p: { type: string }) => p.type)).toEqual(CLIENT_TYPES);
    expect(res.body.preferences[0]).toEqual({
      type: 'APPLICATION_CREATED',
      category: 'APPLICATION',
      inApp: true,
      email: true,
      inAppLocked: false,
      emailLocked: false,
    });
  });

  it('a FREELANCER gets its 18 types in notification-catalog order', async () => {
    const freelancer = await makeFreelancer();

    const res = await get(freelancer);

    expect(res.body.preferences.map((p: { type: string }) => p.type)).toEqual(FREELANCER_TYPES);
    for (const item of res.body.preferences) {
      expect(Object.keys(item).sort()).toEqual(['category', 'email', 'emailLocked', 'inApp', 'inAppLocked', 'type']);
    }
    expect(entry(res, 'SETTLEMENT_FAILED')).toMatchObject({ category: 'SETTLEMENT', inAppLocked: true, emailLocked: true, inApp: true, email: true });
    expect(entry(res, 'SETTLEMENT_SCHEDULED')).toMatchObject({ inApp: true, email: false, inAppLocked: false, emailLocked: false });
  });

  it('the digest is a locked-off in-app channel: inApp false, inAppLocked true', async () => {
    const freelancer = await makeFreelancer();

    const res = await get(freelancer);

    expect(entry(res, 'MESSAGE_UNREAD_DIGEST')).toEqual({
      type: 'MESSAGE_UNREAD_DIGEST',
      category: 'MESSAGE',
      inApp: false,
      email: true,
      inAppLocked: true,
      emailLocked: false,
    });
  });

  it('reflects stored choices, ignores stored values for locked channels, and hides other-role rows', async () => {
    const freelancer = await makeFreelancer();
    await makeNotificationPreference(freelancer.id, 'MILESTONE_DUE_SOON', { inApp: false, email: false });
    await makeNotificationPreference(freelancer.id, 'SETTLEMENT_FAILED', { email: false });
    await makeNotificationPreference(freelancer.id, 'APPLICATION_CREATED', { email: false });

    const res = await get(freelancer);

    expect(entry(res, 'MILESTONE_DUE_SOON')).toMatchObject({ inApp: false, email: false });
    expect(entry(res, 'SETTLEMENT_FAILED')).toMatchObject({ email: true });
    expect(entry(res, 'APPLICATION_CREATED')).toBeUndefined();
    expect(res.body.preferences).toHaveLength(18);
  });

  it('lists by the stored role, not the token\'s', async () => {
    const user = await makeFreelancer();
    await prisma.user.update({ where: { id: user.id }, data: { role: 'CLIENT' } });

    const res = await get(user); // the token still says FREELANCER

    expect(res.body.preferences.map((p: { type: string }) => p.type)).toEqual(CLIENT_TYPES);
  });

  it('writes nothing', async () => {
    const freelancer = await makeFreelancer();

    await get(freelancer);

    expect(await prisma.notificationPreference.count()).toBe(0);
  });
});

describe('PUT /api/notifications/preferences — validation', () => {
  const longArray = Array.from({ length: 22 }, () => ({ type: 'MILESTONE_DUE_SOON', email: false }));

  it.each([
    ['missing', {}],
    ['not an array', { preferences: { type: 'MILESTONE_DUE_SOON', email: false } }],
    ['empty', { preferences: [] }],
    ['longer than 21', { preferences: longArray }],
    ['a body that is an array', [{ type: 'MILESTONE_DUE_SOON', email: false }]],
  ])('preferences %s → 400 `preferences: Expected 1 to 21 entries`', async (_label, body) => {
    const user = await makeFreelancer();

    const res = await put(user, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'preferences: Expected 1 to 21 entries' } });
  });

  it.each([
    ['an entry that is not an object', [{ type: 'MILESTONE_DUE_SOON', email: false }, 'x'], 'preferences.1: Expected an object'],
    ['an array entry', [[]], 'preferences.0: Expected an object'],
    ['a null entry', [null], 'preferences.0: Expected an object'],
    ['an unknown type', [{ type: 'NOPE', email: false }], 'preferences.0.type: Unknown notification type'],
    ['a missing type', [{ email: false }], 'preferences.0.type: Unknown notification type'],
    ['a string inApp', [{ type: 'MILESTONE_DUE_SOON', inApp: 'false' }], 'preferences.0.inApp: Expected a boolean'],
    ['a numeric inApp', [{ type: 'MILESTONE_DUE_SOON', inApp: 0 }], 'preferences.0.inApp: Expected a boolean'],
    ['a null email', [{ type: 'MILESTONE_DUE_SOON', email: null }], 'preferences.0.email: Expected a boolean'],
    ['neither channel', [{ type: 'MILESTONE_DUE_SOON' }], 'preferences.0: Specify inApp or email'],
    ['a duplicate type', [{ type: 'MILESTONE_DUE_SOON', email: false }, { type: 'MILESTONE_DUE_SOON', inApp: false }], 'preferences.1.type: Duplicate notification type'],
    ['the digest\'s in-app turned on', [{ type: 'MESSAGE_UNREAD_DIGEST', inApp: true }], 'preferences.0.inApp: MESSAGE_UNREAD_DIGEST has no in-app notifications'],
    ['a locked in-app turned off', [{ type: 'MILESTONE_FUNDED', inApp: false }], 'preferences.0.inApp: MILESTONE_FUNDED in-app notifications cannot be disabled'],
    ['a locked email turned off', [{ type: 'SETTLEMENT_ON_HOLD', email: false }], 'preferences.0.email: SETTLEMENT_ON_HOLD email notifications cannot be disabled'],
  ])('%s → 400 with the exact path-prefixed message', async (_label, preferences, message) => {
    const user = await makeFreelancer();

    const res = await put(user, { preferences });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
  });

  it('checks type → inApp → email within an entry', async () => {
    const user = await makeFreelancer();

    const res = await put(user, { preferences: [{ email: 'x', inApp: 'y', type: 'NOPE' }] });
    const res2 = await put(user, { preferences: [{ email: 'x', inApp: 'y', type: 'MILESTONE_DUE_SOON' }] });

    expect(res.body.error.message).toBe('preferences.0.type: Unknown notification type');
    expect(res2.body.error.message).toBe('preferences.0.inApp: Expected a boolean');
  });

  it('reports a shape failure anywhere before any entry-rule failure', async () => {
    const user = await makeFreelancer();

    const res = await put(user, { preferences: [{ type: 'MILESTONE_FUNDED', inApp: false }, { type: 'NOPE' }] });

    expect(res.body.error.message).toBe('preferences.1.type: Unknown notification type');
  });

  it('reports entry rules in array order, the first failure only', async () => {
    const user = await makeFreelancer();

    const res = await put(user, {
      preferences: [
        { type: 'MILESTONE_DUE_SOON', email: false },
        { type: 'SETTLEMENT_FAILED', email: false },
        { type: 'MILESTONE_DUE_SOON' },
      ],
    });

    expect(res.body.error.message).toBe('preferences.1.email: SETTLEMENT_FAILED email notifications cannot be disabled');
  });

  it('reports the first failing rule when one entry breaks several (duplicate before locked channel)', async () => {
    const user = await makeFreelancer();

    const dup = await put(user, { preferences: [{ type: 'MILESTONE_FUNDED', email: false }, { type: 'MILESTONE_FUNDED', inApp: false }] });
    const both = await put(user, { preferences: [{ type: 'SETTLEMENT_FAILED', inApp: false, email: false }] });

    expect(dup.body.error.message).toBe('preferences.1.type: Duplicate notification type');
    expect(both.body.error.message).toBe('preferences.0.inApp: SETTLEMENT_FAILED in-app notifications cannot be disabled');
  });

  it('ignores other keys', async () => {
    const user = await makeFreelancer();

    const res = await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', email: false, label: 'x' }], extra: 1 });

    expect(res.status).toBe(200);
  });

  it('a failing request writes nothing at all, even its valid entries', async () => {
    const user = await makeFreelancer();

    const res = await put(user, {
      preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }, { type: 'MILESTONE_FUNDED', inApp: false }],
    });

    expect(res.status).toBe(400);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });
});

describe('PUT /api/notifications/preferences — writes', () => {
  it('turns one email channel off and responds with the same body GET returns after the write', async () => {
    const user = await makeFreelancer();

    const res = await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }] });

    expect(res.status).toBe(200);
    const after = await get(user);
    expect(res.body).toEqual(after.body);
    expect(entry(res, 'MILESTONE_DUE_SOON')).toMatchObject({ inApp: true, email: false });
    expect(await storedRows(user.id)).toEqual([{ type: 'MILESTONE_DUE_SOON', inApp: null, email: false }]);
  });

  it('is partial: a type left out of the body and an omitted channel keep their setting', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'MILESTONE_DUE_SOON', { inApp: false, email: false });
    await makeNotificationPreference(user.id, 'MILESTONE_OVERDUE', { email: false });

    await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', email: true }] });

    expect(await storedRows(user.id)).toEqual([
      { type: 'MILESTONE_DUE_SOON', inApp: false, email: null },
      { type: 'MILESTONE_OVERDUE', inApp: null, email: false },
    ]);
  });

  it('stores a value equal to the default as null and deletes a row left all-null', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'APPLICATION_REJECTED', { inApp: false, email: true });

    await put(user, { preferences: [{ type: 'APPLICATION_REJECTED', inApp: true }] });
    expect(await storedRows(user.id)).toEqual([{ type: 'APPLICATION_REJECTED', inApp: null, email: true }]);

    await put(user, { preferences: [{ type: 'APPLICATION_REJECTED', email: false }] });
    expect(await storedRows(user.id)).toEqual([]);
  });

  it('a locked channel set to its own value passes and stores nothing', async () => {
    const user = await makeFreelancer();

    const res = await put(user, {
      preferences: [
        { type: 'MILESTONE_FUNDED', inApp: true },
        { type: 'SETTLEMENT_FAILED', inApp: true, email: true },
        { type: 'MESSAGE_UNREAD_DIGEST', inApp: false },
      ],
    });

    expect(res.status).toBe(200);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('a locked channel\'s stored value is cleared by a write to that type', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'MILESTONE_FUNDED', { inApp: false });

    await put(user, { preferences: [{ type: 'MILESTONE_FUNDED', email: false }] });

    expect(await storedRows(user.id)).toEqual([{ type: 'MILESTONE_FUNDED', inApp: null, email: false }]);
  });

  it('GET\'s array sent back unchanged round-trips with 200 and no rows', async () => {
    for (const user of [await makeClient(), await makeFreelancer()]) {
      const before = await get(user);

      const res = await put(user, { preferences: before.body.preferences });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(before.body);
    }
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('a type the caller\'s role does not receive is accepted and stored, but not listed', async () => {
    const client = await makeClient();

    const res = await put(client, { preferences: [{ type: 'SETTLEMENT_SCHEDULED', email: true }] });

    expect(res.status).toBe(200);
    expect(entry(res, 'SETTLEMENT_SCHEDULED')).toBeUndefined();
    expect(await storedRows(client.id)).toEqual([{ type: 'SETTLEMENT_SCHEDULED', inApp: null, email: true }]);
  });

  it('sending the same body twice leaves the same rows and returns the same response', async () => {
    const user = await makeFreelancer();
    const body = { preferences: [{ type: 'MILESTONE_OVERDUE', inApp: false, email: false }, { type: 'SETTLEMENT_SCHEDULED', email: true }] };

    const first = await put(user, body);
    const rowsAfterFirst = await prisma.notificationPreference.findMany({ orderBy: { type: 'asc' } });
    const second = await put(user, body);
    const rowsAfterSecond = await prisma.notificationPreference.findMany({ orderBy: { type: 'asc' } });

    expect(second.body).toEqual(first.body);
    expect(rowsAfterSecond).toEqual(rowsAfterFirst);
  });

  it('only touches the caller\'s rows', async () => {
    const user = await makeFreelancer();
    const other = await makeFreelancer();
    await makeNotificationPreference(other.id, 'MILESTONE_DUE_SOON', { email: false });

    await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', email: true }] });

    expect(await storedRows(other.id)).toEqual([{ type: 'MILESTONE_DUE_SOON', inApp: null, email: false }]);
  });

  it('concurrent PUTs of one user serialize on the User row: no 500, one row per type', async () => {
    const user = await makeFreelancer();
    const bodies = [
      { preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }, { type: 'MILESTONE_OVERDUE', email: false }] },
      { preferences: [{ type: 'MILESTONE_OVERDUE', inApp: false }, { type: 'MILESTONE_DUE_SOON', inApp: false }] },
    ];

    for (let round = 0; round < 3; round += 1) {
      await prisma.notificationPreference.deleteMany();
      const results = await Promise.all([...bodies, ...bodies].map((body) => put(user, body)));

      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await storedRows(user.id)).toEqual([
        { type: 'MILESTONE_DUE_SOON', inApp: false, email: false },
        { type: 'MILESTONE_OVERDUE', inApp: false, email: false },
      ]);
    }
  });

  it('a saved preference is what notify() applies next', async () => {
    const user = await makeFreelancer();
    await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', inApp: false, email: false }] });

    expect(await notify(prisma, { userId: user.id, type: 'MILESTONE_DUE_SOON', title: 't', message: 'm' })).toBeNull();
    expect(await prisma.emailDelivery.count()).toBe(0);
  });

  it('preference rows outlive a soft deletion and apply again after a restore', async () => {
    const user = await makeFreelancer();
    await put(user, { preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }] });
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });

    await notify(prisma, { userId: user.id, type: 'MILESTONE_DUE_SOON', title: 't', message: 'm' });

    expect(await prisma.notificationPreference.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.emailDelivery.count()).toBe(0);
  });
});
