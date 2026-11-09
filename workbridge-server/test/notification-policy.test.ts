import { describe, expect, it } from 'vitest';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeApplication,
  makeClient,
  makeFreelancer,
  makeNotificationPreference,
  makeProject,
} from './helpers/factories';
import { jobsOf } from './helpers/jobs';
import { notify } from '../src/lib/notifications/notify';
import {
  NOTIFICATION_POLICY,
  NOTIFICATION_TYPES,
  effectiveChannels,
  normalizeStored,
  typesForRole,
} from '../src/lib/notifications/policy';
import type { NotificationType } from '../src/lib/notifications/types';

/**
 * The channel policy table, the effective-channel rule (a locked channel ignores the stored
 * preference), sparse preference storage and how `notify()` applies them, including the four
 * pre-existing types it now carries.
 */

const LOCKED_IN_APP: NotificationType[] = [
  'APPLICATION_ACCEPTED', 'CONTRACT_ACTIVATED', 'MILESTONE_PLAN_UPDATED', 'MILESTONE_FUNDED',
  'MILESTONE_SUBMITTED', 'MILESTONE_REVISION_REQUESTED', 'MILESTONE_APPROVED', 'MILESTONE_AUTO_APPROVED',
  'MILESTONE_AUTO_APPROVE_REMINDER', 'CONTRACT_COMPLETED', 'SETTLEMENT_PAID', 'SETTLEMENT_ON_HOLD',
  'SETTLEMENT_FAILED', 'MESSAGE_UNREAD_DIGEST',
];
const LOCKED_EMAIL: NotificationType[] = ['MILESTONE_AUTO_APPROVE_REMINDER', 'SETTLEMENT_ON_HOLD', 'SETTLEMENT_FAILED'];
const EMAIL_OFF_BY_DEFAULT: NotificationType[] = ['APPLICATION_REJECTED', 'PROJECT_STATUS_CHANGED', 'SETTLEMENT_SCHEDULED'];

describe('policy table', () => {
  it('has the 20 types in catalog order, the digest last', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(20);
    expect(new Set(NOTIFICATION_TYPES).size).toBe(20);
    expect(NOTIFICATION_TYPES[0]).toBe('APPLICATION_CREATED');
    expect(NOTIFICATION_TYPES[19]).toBe('MESSAGE_UNREAD_DIGEST');
  });

  it('locks trade and money types in-app, and three types by email too', () => {
    for (const policy of NOTIFICATION_POLICY) {
      expect(policy.inApp.locked, policy.type).toBe(LOCKED_IN_APP.includes(policy.type));
      expect(policy.email.locked, policy.type).toBe(LOCKED_EMAIL.includes(policy.type));
      expect(policy.email.on, policy.type).toBe(!EMAIL_OFF_BY_DEFAULT.includes(policy.type));
      expect(policy.inApp.on, policy.type).toBe(policy.type !== 'MESSAGE_UNREAD_DIGEST');
    }
  });

  it('gives a CLIENT 8 types and a FREELANCER 17, the five "both" types included', () => {
    expect(typesForRole('CLIENT')).toHaveLength(8);
    expect(typesForRole('FREELANCER')).toHaveLength(17);
    expect(NOTIFICATION_POLICY.filter((p) => p.recipient === 'BOTH')).toHaveLength(5);
  });
});

describe('effective channels and sparse storage', () => {
  it('uses the default when nothing is stored, the stored value for an unlocked channel', () => {
    expect(effectiveChannels('APPLICATION_REJECTED', null)).toEqual({ inApp: true, email: false });
    expect(effectiveChannels('APPLICATION_REJECTED', { inApp: false, email: true })).toEqual({ inApp: false, email: true });
    expect(effectiveChannels('APPLICATION_REJECTED', { inApp: null, email: true })).toEqual({ inApp: true, email: true });
  });

  it('ignores a stored value for a locked channel, the digest\'s locked-off in-app included', () => {
    expect(effectiveChannels('SETTLEMENT_FAILED', { inApp: false, email: false })).toEqual({ inApp: true, email: true });
    expect(effectiveChannels('MESSAGE_UNREAD_DIGEST', { inApp: true, email: null })).toEqual({ inApp: false, email: true });
  });

  it('stores a default value or a locked channel as null', () => {
    expect(normalizeStored('APPLICATION_REJECTED', { inApp: true, email: false })).toEqual({ inApp: null, email: null });
    expect(normalizeStored('APPLICATION_REJECTED', { inApp: false, email: true })).toEqual({ inApp: false, email: true });
    expect(normalizeStored('MILESTONE_FUNDED', { inApp: true, email: false })).toEqual({ inApp: null, email: false });
    expect(normalizeStored('MESSAGE_UNREAD_DIGEST', { inApp: false, email: false })).toEqual({ inApp: null, email: false });
  });
});

describe('notify() applies the policy and the recipient\'s preferences', () => {
  const send = (userId: string, type: NotificationType) =>
    notify(prisma, { userId, type, title: 't', message: 'm', href: '/x' });

  it('defaults: in-app and email for an email-on type, in-app only for an email-off type', async () => {
    const user = await makeFreelancer();

    await send(user.id, 'MILESTONE_DUE_SOON');
    await send(user.id, 'SETTLEMENT_SCHEDULED');

    expect((await prisma.notification.findMany({ orderBy: { createdAt: 'asc' } })).map((n) => n.type).sort())
      .toEqual(['MILESTONE_DUE_SOON', 'SETTLEMENT_SCHEDULED']);
    const deliveries = await prisma.emailDelivery.findMany();
    expect(deliveries.map((d) => d.type)).toEqual(['MILESTONE_DUE_SOON']);
  });

  it('an unlocked channel follows the stored choice: in-app off, email on', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'MILESTONE_DUE_SOON', { inApp: false });
    await makeNotificationPreference(user.id, 'SETTLEMENT_SCHEDULED', { email: true });

    expect(await send(user.id, 'MILESTONE_DUE_SOON')).toBeNull();
    await send(user.id, 'SETTLEMENT_SCHEDULED');

    expect((await prisma.notification.findMany()).map((n) => n.type)).toEqual(['SETTLEMENT_SCHEDULED']);
    const deliveries = await prisma.emailDelivery.findMany({ orderBy: { type: 'asc' } });
    expect(deliveries.map((d) => [d.type, d.notificationId === null])).toEqual([
      ['MILESTONE_DUE_SOON', true], // in-app off → no row to link
      ['SETTLEMENT_SCHEDULED', false],
    ]);
  });

  it('a stored value for a locked channel is ignored', async () => {
    const user = await makeFreelancer();
    await makeNotificationPreference(user.id, 'SETTLEMENT_FAILED', { inApp: false, email: false });

    await send(user.id, 'SETTLEMENT_FAILED');

    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.emailDelivery.count()).toBe(1);
  });

  it('a preference of another type or another user does not apply', async () => {
    const user = await makeFreelancer();
    const other = await makeFreelancer();
    await makeNotificationPreference(user.id, 'MILESTONE_OVERDUE', { email: false });
    await makeNotificationPreference(other.id, 'MILESTONE_DUE_SOON', { email: false });

    await send(user.id, 'MILESTONE_DUE_SOON');

    expect(await prisma.emailDelivery.count({ where: { userId: user.id } })).toBe(1);
  });

  it('both channels off writes nothing at all', async () => {
    const user = await makeClient();
    await makeNotificationPreference(user.id, 'APPLICATION_CREATED', { inApp: false, email: false });

    expect(await send(user.id, 'APPLICATION_CREATED')).toBeNull();

    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.emailDelivery.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('the recipient\'s role plays no part', async () => {
    const client = await makeClient();

    await send(client.id, 'MILESTONE_FUNDED'); // a freelancer type, sent to a client

    expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(1);
    expect(await prisma.emailDelivery.count({ where: { userId: client.id } })).toBe(1);
  });
});

describe('the four pre-existing types go through notify()', () => {
  const applyBody = { coverLetter: '지원합니다', expectedRate: 3_000_000, expectedDuration: '4주' };

  it('applying: APPLICATION_CREATED keeps its row and adds an email for the client', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).post(`/api/projects/${project.id}/applications`).send(applyBody);

    expect(res.status).toBe(201);
    const [notification] = await prisma.notification.findMany();
    expect(notification).toMatchObject({ userId: client.id, type: 'APPLICATION_CREATED', href: `/projects/${project.id}/applications` });
    const [delivery] = await prisma.emailDelivery.findMany();
    expect(delivery).toMatchObject({ userId: client.id, type: 'APPLICATION_CREATED', notificationId: notification.id, toAddress: client.email });
    expect(await jobsOf('notification.email')).toHaveLength(1);
  });

  it('applying: a client who turned APPLICATION_CREATED off gets nothing', async () => {
    const client = await makeClient();
    await makeNotificationPreference(client.id, 'APPLICATION_CREATED', { inApp: false, email: false });
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).post(`/api/projects/${project.id}/applications`).send(applyBody);

    expect(res.status).toBe(201);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.emailDelivery.count()).toBe(0);
  });

  it('applying to a soft-deleted client still creates the in-app row but no email', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).post(`/api/projects/${project.id}/applications`).send(applyBody);

    expect(res.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(1);
    expect(await prisma.emailDelivery.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('accepting: APPLICATION_ACCEPTED emails the winner; bulk-rejected applicants get in-app only', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const winner = await makeFreelancer();
    const loser = await makeFreelancer();
    const app = await makeApplication(project.id, winner.id);
    await makeApplication(project.id, loser.id);

    const res = await authed(client).patch(`/api/projects/${project.id}/applications/${app.id}`).send({ status: 'ACCEPTED' });

    expect(res.status).toBe(200);
    const notifications = await prisma.notification.findMany({ select: { userId: true, type: true } });
    expect(notifications).toEqual(expect.arrayContaining([
      { userId: winner.id, type: 'APPLICATION_ACCEPTED' },
      { userId: loser.id, type: 'APPLICATION_REJECTED' },
    ]));
    const deliveries = await prisma.emailDelivery.findMany({ select: { userId: true, type: true } });
    expect(deliveries).toEqual([{ userId: winner.id, type: 'APPLICATION_ACCEPTED' }]);
  });

  it('accepting: a rejected applicant who opted in to APPLICATION_REJECTED email gets one', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const winner = await makeFreelancer();
    const loser = await makeFreelancer();
    await makeNotificationPreference(loser.id, 'APPLICATION_REJECTED', { email: true });
    const app = await makeApplication(project.id, winner.id);
    await makeApplication(project.id, loser.id);

    await authed(client).patch(`/api/projects/${project.id}/applications/${app.id}`).send({ status: 'ACCEPTED' });

    expect(await prisma.emailDelivery.count({ where: { userId: loser.id, type: 'APPLICATION_REJECTED' } })).toBe(1);
  });

  it('rejecting: APPLICATION_REJECTED is in-app only by default, and can be turned off', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    await makeNotificationPreference(b.id, 'APPLICATION_REJECTED', { inApp: false });
    const appA = await makeApplication(project.id, a.id);
    const appB = await makeApplication(project.id, b.id);

    await authed(client).patch(`/api/projects/${project.id}/applications/${appA.id}`).send({ status: 'REJECTED' });
    await authed(client).patch(`/api/projects/${project.id}/applications/${appB.id}`).send({ status: 'REJECTED' });

    expect((await prisma.notification.findMany()).map((n) => n.userId)).toEqual([a.id]);
    expect(await prisma.emailDelivery.count()).toBe(0);
  });

  it('closing a project by hand: PROJECT_STATUS_CHANGED follows each applicant\'s preference', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const a = await makeFreelancer();
    const b = await makeFreelancer();
    await makeNotificationPreference(b.id, 'PROJECT_STATUS_CHANGED', { inApp: false, email: true });
    await makeApplication(project.id, a.id);
    await makeApplication(project.id, b.id);

    const res = await authed(client).patch(`/api/projects/${project.id}/status`).send({ status: 'CLOSED' });

    expect(res.status).toBe(200);
    expect((await prisma.notification.findMany()).map((n) => [n.userId, n.type])).toEqual([[a.id, 'PROJECT_STATUS_CHANGED']]);
    expect((await prisma.emailDelivery.findMany()).map((d) => [d.userId, d.type])).toEqual([[b.id, 'PROJECT_STATUS_CHANGED']]);
  });
});
