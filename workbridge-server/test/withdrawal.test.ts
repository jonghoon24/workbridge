import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Withdrawal deletes public images, and the race tests upload one. No test may reach Supabase.
vi.mock('@supabase/supabase-js', async () => {
  const { storage } = await import('./helpers/storageFake.js');
  return { createClient: () => storage.client };
});

import { hkdfSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';

import { api, authed, tokenFor } from './helpers/api';
import { prisma, sideClient } from './helpers/db';
import {
  makeApplication,
  makeCareer,
  makeClient,
  makeContractScenario,
  makeEmailDelivery,
  makeFreelancer,
  makeMessage,
  makeNotificationPreference,
  makePayoutAccount,
  makePortfolioItem,
  makeProject,
  makeSettlement,
  makeSettlementItem,
  TEST_PASSWORD,
} from './helpers/factories';
import { jobsOf } from './helpers/jobs';
import { storage, STORAGE_BASE } from './helpers/storageFake';
import { runDueJobs } from '../src/jobs/runner';
import { issueReauthProof, REAUTH_AUDIENCE } from '../src/lib/reauth';

/**
 * `GET`/`POST /api/users/me/withdrawal` (docs/domain/accounts.md "회원 탈퇴"), and the writes that
 * must not bring data back into a withdrawn account. 401 and the soft-deleted caller are covered by
 * the authorization and soft-delete matrices.
 */

const PUBLIC = 'workbridge';
const publicUrl = (path: string) => `${STORAGE_BASE}/object/public/${PUBLIC}/${path}`;
const BLOCKED = { error: { message: 'Cannot withdraw while contracts or settlements are unfinished' } };
const NONE = { unfinishedContracts: 0, unsettledEarnings: 0, unpaidSettlements: 0, heldSettlements: 0 };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

beforeEach(() => {
  storage.reset();
});

const status = (user: User) => authed(user).get('/api/users/me/withdrawal');
const withdraw = (user: User, body: Record<string, unknown> = { currentPassword: TEST_PASSWORD }) =>
  authed(user).post('/api/users/me/withdrawal').send(body);

const MINUTE_MS = 60_000;

/**
 * A Google re-authentication proof, as the callback issues it (`google-reauth.test.ts` covers the
 * callback). `authTime` is Google's sign-in time; `null` is a lax-mode proof issued at `issuedAt`.
 */
function reauthProof(
  user: Pick<User, 'id' | 'googleId'>,
  { authTime = new Date(), issuedAt = new Date(), googleSub = user.googleId as string }: { authTime?: Date | null; issuedAt?: Date; googleSub?: string } = {},
) {
  return issueReauthProof({ userId: user.id, googleSub, purpose: 'withdrawal', authTime }, issuedAt);
}

/** A contract between a fresh client and freelancer, in `status`. */
function contractIn(status: 'PENDING' | 'ACTIVE' | 'COMPLETED') {
  return makeContractScenario({
    contract: status === 'PENDING' ? {} : { status, clientSigned: true, freelancerSigned: true, ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}) },
  });
}

/** Polls until `count` sessions wait on a lock (on the side client; see `sideClient`). */
async function waitForLockWaiters(side: ReturnType<typeof sideClient>, count: number) {
  const giveUpAt = Date.now() + 5_000;
  for (;;) {
    const [{ waiting }] = await side.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= count) return;
    if (Date.now() > giveUpAt) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Answer = { status: number; body: unknown };
/** Sends a supertest request now (it is lazy until awaited). */
function started(req: PromiseLike<Answer>) {
  return new Promise<Answer>((resolve, reject) => {
    req.then(resolve, reject);
  });
}

describe('GET /api/users/me/withdrawal', () => {
  it('lets an account with nothing in progress withdraw', async () => {
    const user = await makeFreelancer();
    const googleOnly = await makeClient({ password: null, googleId: 'google-uid-status' });

    const res = await status(user);
    const google = await status(googleOnly);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ canWithdraw: true, hasPassword: true, blockers: NONE });
    expect(google.body).toEqual({ canWithdraw: true, hasPassword: false, blockers: NONE });
  });

  it.each(['PENDING', 'ACTIVE'] as const)('counts a %s contract for both parties', async (contractStatus) => {
    const { client, freelancer } = await contractIn(contractStatus);

    for (const party of [client, freelancer]) {
      const res = await status(party);
      expect(res.body).toEqual({ canWithdraw: false, hasPassword: true, blockers: { ...NONE, unfinishedContracts: 1 } });
    }
  });

  it('does not count a cancelled contract: cancelling it is how an unsigned contract stops blocking', async () => {
    const { client, freelancer, contract } = await contractIn('PENDING');
    expect((await authed(freelancer).post(`/api/contracts/${contract.id}/cancel`)).status).toBe(200);

    expect((await status(client)).body).toEqual({ canWithdraw: true, hasPassword: true, blockers: NONE });
    expect((await status(freelancer)).body.canWithdraw).toBe(true);
  });

  it('does not count a completed contract', async () => {
    const { client, freelancer } = await contractIn('COMPLETED');

    expect((await status(client)).body.canWithdraw).toBe(true);
    expect((await status(freelancer)).body.canWithdraw).toBe(true);
  });

  it('counts an unfinished contract whose project was deleted (the money is still in it)', async () => {
    const { freelancer, project } = await contractIn('ACTIVE');
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    expect((await status(freelancer)).body.blockers.unfinishedContracts).toBe(1);
  });

  it('counts approved earnings that no settlement has picked up yet', async () => {
    const { freelancer, milestone } = await contractIn('COMPLETED');
    await makeSettlementItem(milestone, freelancer.id);

    expect((await status(freelancer)).body).toMatchObject({ canWithdraw: false, blockers: { ...NONE, unsettledEarnings: 1 } });
  });

  it.each([
    ['SCHEDULED', 'unpaidSettlements'],
    ['PROCESSING', 'unpaidSettlements'],
    ['FAILED', 'unpaidSettlements'],
    ['ON_HOLD', 'heldSettlements'],
  ] as const)('counts a %s settlement as %s', async (settlementStatus, key) => {
    const freelancer = await makeFreelancer();
    await makeSettlement(freelancer.id, { status: settlementStatus, payoutAttempts: settlementStatus === 'FAILED' ? 3 : 0 });

    expect((await status(freelancer)).body).toMatchObject({ canWithdraw: false, blockers: { ...NONE, [key]: 1 } });
  });

  it('does not count a paid settlement', async () => {
    const freelancer = await makeFreelancer();
    await makeSettlement(freelancer.id, { status: 'PAID', paidAt: new Date() });

    expect((await status(freelancer)).body.canWithdraw).toBe(true);
  });
});

describe('POST /api/users/me/withdrawal', () => {
  describe('refusals', () => {
    it('refuses a party to an unfinished contract with 409 and changes nothing', async () => {
      const { client, freelancer } = await contractIn('PENDING');
      const item = await makePortfolioItem(freelancer.id);

      const res = await withdraw(freelancer);
      const other = await withdraw(client);

      expect(res.status).toBe(409);
      expect(res.body).toEqual(BLOCKED);
      expect(other.body).toEqual(BLOCKED);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored).toMatchObject({ name: freelancer.name, email: freelancer.email, deletedAt: null });
      expect(await prisma.portfolioItem.count({ where: { id: item.id } })).toBe(1);
    });

    it('refuses a freelancer who is still owed money with 409', async () => {
      const freelancer = await makeFreelancer();
      await makeSettlement(freelancer.id, { status: 'ON_HOLD' });

      const res = await withdraw(freelancer);

      expect(res.status).toBe(409);
      expect(res.body).toEqual(BLOCKED);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } })).deletedAt).toBeNull();
    });

    it('requires the current password of an account that has one', async () => {
      const user = await makeFreelancer();

      const missing = await withdraw(user, {});
      const wrong = await withdraw(user, { currentPassword: 'not-my-password' });

      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ error: { message: 'Current password is required' } });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual({ error: { message: 'Current password is incorrect' } });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
    });

    it.each([
      [{ currentPassword: '' }, 'currentPassword: Current password is required'],
      [{ currentPassword: 1234 }, 'currentPassword: Current password must be a string'],
    ])('rejects %j with 400', async (body, message) => {
      const user = await makeFreelancer();

      const res = await withdraw(user, body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message } });
    });

    describe('a Google-only account', () => {
      const GOOGLE_SUB = 'google-uid-reauth';
      const googleOnly = () => makeClient({ password: null, googleId: GOOGLE_SUB });
      const refused = async (user: User, body: Record<string, unknown>, message: string) => {
        const res = await withdraw(user, body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: { message } });
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
      };
      const INVALID = 'Google re-authentication is invalid or expired';

      afterEach(() => {
        process.env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME = 'false';
      });

      it('requires a Google re-authentication, consent alone is not enough', async () => {
        const user = await googleOnly();

        await refused(user, {}, 'Google re-authentication is required');
        await refused(user, { currentPassword: TEST_PASSWORD }, 'Google re-authentication is required');
      });

      it('refuses a proof whose Google sign-in is older than the window', async () => {
        const user = await googleOnly();

        await refused(user, { reauthToken: reauthProof(user, { authTime: new Date(Date.now() - 6 * MINUTE_MS) }) }, INVALID);
      });

      it('refuses a proof without auth_time once its window from the callback has passed', async () => {
        const user = await googleOnly();
        const sixMinutesAgo = new Date(Date.now() - 6 * MINUTE_MS);

        await refused(user, { reauthToken: reauthProof(user, { authTime: null, issuedAt: sixMinutesAgo }) }, INVALID);
      });

      it('refuses another member\'s proof', async () => {
        const user = await googleOnly();
        const other = await makeClient({ password: null, googleId: 'google-uid-other' });

        await refused(user, { reauthToken: reauthProof(other) }, INVALID);
      });

      it('refuses a proof for a Google account that is not the one linked', async () => {
        const user = await googleOnly();

        await refused(user, { reauthToken: reauthProof(user, { googleSub: 'google-uid-other' }) }, INVALID);
      });

      it('refuses a proof for another purpose', async () => {
        const user = await googleOnly();
        // Signed with the proof key itself, so only the purpose is wrong.
        const key = Buffer.from(hkdfSync('sha256', process.env.JWT_ACCESS_SECRET as string, '', 'workbridge reauth proof', 32));
        const otherPurpose = jwt.sign(
          { purpose: 'payout_account', gsub: GOOGLE_SUB, authTimeVerified: true },
          key,
          { algorithm: 'HS256', audience: REAUTH_AUDIENCE, subject: user.id, expiresIn: '5m' },
        );

        await refused(user, { reauthToken: otherPurpose }, INVALID);
      });

      it('refuses an access token in place of a proof', async () => {
        const user = await googleOnly();

        await refused(user, { reauthToken: tokenFor(user) }, INVALID);
      });

      it('accepts a lax-mode proof without auth_time, but strict mode demands one backed by auth_time', async () => {
        const lax = await googleOnly();
        const strict = await makeClient({ password: null, googleId: 'google-uid-strict' });

        expect((await withdraw(lax, { reauthToken: reauthProof(lax, { authTime: null }) })).status).toBe(200);

        process.env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME = 'true';
        await refused(strict, { reauthToken: reauthProof(strict, { authTime: null }) }, INVALID);
        expect((await withdraw(strict, { reauthToken: reauthProof(strict) })).status).toBe(200);
      });

      it('rejects a non-string or empty reauthToken with 400', async () => {
        const user = await googleOnly();

        await refused(user, { reauthToken: '' }, 'reauthToken: Google re-authentication is required');
        await refused(user, { reauthToken: 42 }, 'reauthToken: Reauth token must be a string');
      });
    });

    it('confirms an account with a password by its password, whatever reauth proof it sends', async () => {
      const user = await makeFreelancer({ googleId: 'google-uid-has-password' });

      const res = await withdraw(user, { reauthToken: reauthProof(user) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Current password is required' } });
    });

    it('shares the wrong-password limit with changing the password', async () => {
      const user = await makeFreelancer();
      for (let i = 0; i < 3; i += 1) {
        await authed(user).post('/api/auth/change-password').send({ currentPassword: `wrong-${i}`, newPassword: 'new-password-1' });
      }
      for (let i = 0; i < 2; i += 1) {
        expect((await withdraw(user, { currentPassword: `wrong-again-${i}` })).status).toBe(400);
      }

      const res = await withdraw(user);

      expect(res.status).toBe(429);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
    });
  });

  describe('a client', () => {
    it('deletes the projects without a contract, rejects their pending applications and tells those applicants', async () => {
      const client = await makeClient({ companyName: '넥스트랩', bio: '소개' });
      const open = await makeProject(client.id, { title: '모집 중 프로젝트', status: 'OPEN' });
      const upcoming = await makeProject(client.id, { title: '모집 예정', status: 'UPCOMING' });
      const pendingApplicant = await makeFreelancer();
      const decidedApplicant = await makeFreelancer();
      const withdrawnApplicant = await makeFreelancer({ deletedAt: new Date() });
      const pendingApp = await makeApplication(open.id, pendingApplicant.id);
      const decidedApp = await makeApplication(open.id, decidedApplicant.id, { status: 'REJECTED' });
      await makeApplication(open.id, withdrawnApplicant.id);
      // A completed contract's project stays: it is the counterpart's record.
      const done = await makeContractScenario({ contract: { status: 'COMPLETED', clientId: client.id, completedAt: new Date() } });
      await prisma.project.update({ where: { id: done.project.id }, data: { clientId: client.id } });

      const res = await withdraw(client);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Account withdrawn' });
      const projects = await prisma.project.findMany({ where: { id: { in: [open.id, upcoming.id, done.project.id] } } });
      const deleted = Object.fromEntries(projects.map((p) => [p.id, p.deletedAt !== null]));
      expect(deleted).toEqual({ [open.id]: true, [upcoming.id]: true, [done.project.id]: false });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: pendingApp.id } })).status).toBe('REJECTED');
      expect((await prisma.application.findUniqueOrThrow({ where: { id: decidedApp.id } })).status).toBe('REJECTED');

      const notices = await prisma.notification.findMany({ where: { type: 'PROJECT_STATUS_CHANGED' } });
      expect(notices.map((n) => ({ userId: n.userId, title: n.title, message: n.message, href: n.href }))).toEqual([{
        userId: pendingApplicant.id,
        title: '프로젝트 모집이 마감되었습니다',
        message: "'모집 중 프로젝트' 프로젝트 모집이 마감되었습니다.",
        href: '/my/applications',
      }]);
    });

    it('deletes a project whose only contract was cancelled, like a project without one', async () => {
      const { client, freelancer, project, contract, application } = await makeContractScenario({ contract: { status: 'CANCELLED' } });
      // Recruiting again after the cancel: a new applicant waits.
      await prisma.project.update({ where: { id: project.id }, data: { status: 'OPEN' } });
      const newcomer = await makeFreelancer();
      const pendingApp = await makeApplication(project.id, newcomer.id);

      const res = await withdraw(client);

      expect(res.status).toBe(200);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).deletedAt).not.toBeNull();
      expect((await prisma.application.findUniqueOrThrow({ where: { id: pendingApp.id } })).status).toBe('REJECTED');
      const notices = await prisma.notification.findMany({ where: { type: 'PROJECT_STATUS_CHANGED' } });
      expect(notices.map((n) => n.userId)).toEqual([newcomer.id]);
      // The contract row stays (the record), and so does the freelancer's accepted application.
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('CANCELLED');
      expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('ACCEPTED');
      expect(freelancer.deletedAt).toBeNull();
    });

    it('scrubs the profile and soft-deletes the account', async () => {
      const client = await makeClient({
        companyName: '넥스트랩', businessField: 'IT', website: 'https://nextlab.example', bio: '소개',
        profileImage: publicUrl('profiles/x.png'),
      });
      const before = Date.now();

      await withdraw(client);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
      expect(stored).toMatchObject({
        name: '탈퇴한 회원',
        email: `withdrawn:${client.id}`,
        password: null,
        googleId: null,
        role: 'CLIENT',
        profileImage: null,
        bio: null,
        companyName: null,
        businessField: null,
        website: null,
        skills: [],
        activityCategory: null,
        experienceYears: null,
        hourlyRate: null,
        portfolioUrl: null,
      });
      expect(stored.deletedAt?.getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(stored.passwordChangedAt?.getTime()).toBe(stored.deletedAt?.getTime());
    });
  });

  describe('a freelancer', () => {
    it('deletes personal data and undecided applications, and keeps the transaction records', async () => {
      const done = await makeContractScenario({ contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true, completedAt: new Date() } });
      const { freelancer, client, contract, milestone, application, conversation } = done;
      await prisma.user.update({ where: { id: freelancer.id }, data: { skills: ['React'], hourlyRate: 50_000, experienceYears: 3 } });
      await makeSettlementItem(milestone, freelancer.id, { settlementId: (await makeSettlement(freelancer.id, { status: 'PAID', paidAt: new Date(), accountHolder: freelancer.name })).id });
      await makePortfolioItem(freelancer.id, { imageUrl: publicUrl('portfolio/a.png') });
      await makePortfolioItem(freelancer.id, { imageUrl: 'https://cdn.example.com/elsewhere.png' });
      await makeCareer(freelancer.id);
      await makePayoutAccount(freelancer);
      await makeNotificationPreference(freelancer.id, 'APPLICATION_REJECTED', { email: true });
      await prisma.notification.create({ data: { userId: freelancer.id, type: 'APPLICATION_ACCEPTED', title: 't', message: 'm' } });
      const delivery = await makeEmailDelivery(freelancer);
      const sent = await makeEmailDelivery(freelancer, { status: 'SENT' });
      const otherProject = await makeProject(client.id, { status: 'OPEN' });
      const rejectedProject = await makeProject(client.id, { status: 'CLOSED' });
      await makeApplication(otherProject.id, freelancer.id);
      await makeApplication(rejectedProject.id, freelancer.id, { status: 'REJECTED' });
      await prisma.projectBookmark.create({ data: { userId: freelancer.id, projectId: otherProject.id } });
      await makeMessage(conversation.id, freelancer.id, { body: '마지막 메시지' });
      await prisma.review.create({ data: { contractId: contract.id, reviewerId: freelancer.id, revieweeId: client.id, rating: 5, content: '좋았습니다', tags: [] } });

      const res = await withdraw(freelancer);

      expect(res.status).toBe(200);
      const userId = freelancer.id;
      expect(await prisma.portfolioItem.count({ where: { userId } })).toBe(0);
      expect(await prisma.career.count({ where: { userId } })).toBe(0);
      expect(await prisma.payoutAccount.count({ where: { userId } })).toBe(0);
      expect(await prisma.projectBookmark.count({ where: { userId } })).toBe(0);
      expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(0);
      expect(await prisma.notification.count({ where: { userId } })).toBe(0);
      // Undecided applications are withdrawn; the one behind the contract stays.
      expect((await prisma.application.findMany({ where: { freelancerId: userId } })).map((a) => a.id)).toEqual([application.id]);
      // Email records stay with their status, without address or content.
      const deliveries = await prisma.emailDelivery.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      expect(deliveries.map((d) => [d.id, d.status, d.toAddress, d.subject, d.body])).toEqual([
        [delivery.id, 'PENDING', `withdrawn:${userId}`, '', ''],
        [sent.id, 'SENT', `withdrawn:${userId}`, '', ''],
      ]);
      // Transaction records stay.
      expect(await prisma.contract.count({ where: { id: contract.id } })).toBe(1);
      expect(await prisma.settlement.count({ where: { freelancerId: userId, accountHolder: freelancer.name } })).toBe(1);
      expect(await prisma.settlementItem.count({ where: { freelancerId: userId } })).toBe(1);
      expect(await prisma.message.count({ where: { senderId: userId } })).toBe(1);
      expect(await prisma.review.count({ where: { reviewerId: userId } })).toBe(1);
      // The public images go with a job; a URL outside our bucket is not ours to delete.
      const [job] = await jobsOf('account.deletePublicFiles');
      expect(job.payload).toEqual({ userId, paths: ['portfolio/a.png'] });
    });

    it('shows the counterpart a withdrawn member, and keeps the reviews they wrote', async () => {
      const { freelancer, client, contract } = await makeContractScenario({
        contract: { status: 'COMPLETED', clientSigned: true, freelancerSigned: true, completedAt: new Date() },
      });
      await prisma.review.create({ data: { contractId: contract.id, reviewerId: freelancer.id, revieweeId: client.id, rating: 4, content: '좋았습니다', tags: [] } });

      await withdraw(freelancer);

      const detail = await authed(client).get(`/api/contracts/${contract.id}`);
      expect(detail.body.freelancer).toMatchObject({ id: freelancer.id, name: '탈퇴한 회원', profileImage: null });
      const { body: { id: conversationId } } = await authed(client).get(`/api/contracts/${contract.id}/conversation`);
      const conversation = await authed(client).get(`/api/conversations/${conversationId}`);
      expect(conversation.body.conversation).toMatchObject({
        counterpart: { id: freelancer.id, name: '탈퇴한 회원', profileImage: null },
        canSend: false,
        closedReason: 'COUNTERPART_INACTIVE',
      });
      const reviews = await api().get(`/api/users/${client.id}/reviews`);
      expect(JSON.stringify(reviews.body)).toContain('탈퇴한 회원');
      expect((await api().get(`/api/users/${freelancer.id}`)).status).toBe(404);
    });
  });

  describe('afterwards', () => {
    it('cannot log in or refresh, and the email can sign up again as a new account', async () => {
      const user = await makeFreelancer();
      const login = await api().post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD });
      const cookie = [login.headers['set-cookie']].flat().find((c) => String(c).startsWith('refreshToken='));

      expect((await withdraw(user)).status).toBe(200);

      const again = await api().post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD });
      expect(again.status).toBe(401);
      expect((await api().post('/api/auth/refresh').set('Cookie', String(cookie).split(';')[0])).status).toBe(401);
      const signup = await api().post('/api/auth/signup').send({ email: user.email, password: TEST_PASSWORD, name: '다시 가입', role: 'CLIENT' });
      expect(signup.status).toBe(201);
      expect(signup.body.user.id).not.toBe(user.id);
    });

    it('lets a Google-only account withdraw after a fresh Google re-authentication, freeing its Google link', async () => {
      const user = await makeClient({ password: null, googleId: 'google-uid-withdraw' });

      const res = await withdraw(user, { reauthToken: reauthProof(user) });

      expect(res.status).toBe(200);
      expect(await prisma.user.count({ where: { googleId: 'google-uid-withdraw' } })).toBe(0);
    });

    it('refuses the withdrawn tombstone address at signup, so nobody can take it first', async () => {
      const user = await makeFreelancer();

      const res = await api().post('/api/auth/signup').send({ email: `withdrawn:${user.id}`, password: TEST_PASSWORD, name: 'x', role: 'CLIENT' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'email: Email must be a valid email address' } });
    });
  });

  describe('public files', () => {
    it('deletes the captured images and every profile image of the user', async () => {
      const user = await makeFreelancer();
      for (const path of [`profiles/${user.id}-old.png`, `profiles/${user.id}-new.png`, 'profiles/someone-else.png', 'portfolio/p1.png']) {
        storage.put(PUBLIC, path, { size: 1, contentType: 'image/png' });
      }
      await prisma.user.update({ where: { id: user.id }, data: { profileImage: publicUrl(`profiles/${user.id}-new.png`) } });
      await makePortfolioItem(user.id, { imageUrl: publicUrl('portfolio/p1.png') });

      await withdraw(user);
      await runDueJobs({ now: new Date(Date.now() + 1000), types: ['account.deletePublicFiles'] });

      expect(storage.has(PUBLIC, `profiles/${user.id}-old.png`)).toBe(false);
      expect(storage.has(PUBLIC, `profiles/${user.id}-new.png`)).toBe(false);
      expect(storage.has(PUBLIC, 'portfolio/p1.png')).toBe(false);
      expect(storage.has(PUBLIC, 'profiles/someone-else.png')).toBe(true);
      expect((await jobsOf('account.deletePublicFiles'))[0].status).toBe('SUCCEEDED');
    });

    it('never deletes the files of an active account', async () => {
      const user = await makeFreelancer();
      storage.put(PUBLIC, `profiles/${user.id}-a.png`, { size: 1, contentType: 'image/png' });
      await prisma.job.create({ data: { type: 'account.deletePublicFiles', payload: { userId: user.id, paths: [`profiles/${user.id}-a.png`] } } });

      await runDueJobs({ now: new Date(Date.now() + 1000), types: ['account.deletePublicFiles'] });

      expect(storage.has(PUBLIC, `profiles/${user.id}-a.png`)).toBe(true);
    });
  });

  it('writes nothing when a late step fails', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id);
    // Another row already holds the tombstone address, so scrubbing the account fails at the end.
    await makeClient({ email: `withdrawn:${freelancer.id}` });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await withdraw(freelancer);

      expect(res.status).toBe(500);
      expect(logs).toHaveBeenCalledTimes(1);
    } finally {
      logs.mockRestore();
    }
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({ name: freelancer.name, deletedAt: null });
    expect(await prisma.portfolioItem.count({ where: { id: item.id } })).toBe(1);
    expect(await jobsOf('account.deletePublicFiles')).toHaveLength(0);
  });

  describe('racing an accept of the freelancer\'s application', () => {
    it('removes the application first when the withdrawal locks it first: the accept is a 404', async () => {
      const client = await makeClient();
      const freelancer = await makeFreelancer();
      const project = await makeProject(client.id, { status: 'OPEN' });
      const application = await makeApplication(project.id, freelancer.id);

      const side = sideClient();
      let withdrawal: Promise<Answer> | undefined;
      let accept: Promise<Answer> | undefined;
      try {
        await side.$transaction(async (tx) => {
          // Hold the freelancer's row: the withdrawal locks the application, then waits here.
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${freelancer.id} FOR UPDATE`;
          withdrawal = started(withdraw(freelancer));
          await waitForLockWaiters(side, 1);
          accept = started(authed(client).patch(`/api/projects/${project.id}/applications/${application.id}`).send({ status: 'ACCEPTED' }));
          await waitForLockWaiters(side, 2);
        }, { timeout: 10_000 });
      } finally {
        await side.$disconnect();
      }

      const [w, a] = await Promise.all([withdrawal!, accept!]);
      expect(w.status).toBe(200);
      expect(a.status).toBe(404);
      expect(a.body).toEqual({ error: { message: 'Application not found' } });
      expect(await prisma.contract.count()).toBe(0);
    }, 20_000);

    it('sees the contract when the accept gets there first: the withdrawal is a 409', async () => {
      const client = await makeClient();
      const freelancer = await makeFreelancer();
      const project = await makeProject(client.id, { status: 'OPEN' });
      const application = await makeApplication(project.id, freelancer.id);

      const side = sideClient();
      let withdrawal: Promise<Answer> | undefined;
      let accept: Promise<Answer> | undefined;
      try {
        await side.$transaction(async (tx) => {
          // Hold the freelancer's row: the accept takes the application, then waits here to write
          // the contract (its foreign key); the withdrawal then waits for the application.
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${freelancer.id} FOR UPDATE`;
          accept = started(authed(client).patch(`/api/projects/${project.id}/applications/${application.id}`).send({ status: 'ACCEPTED' }));
          await waitForLockWaiters(side, 1);
          withdrawal = started(withdraw(freelancer));
          await waitForLockWaiters(side, 2);
        }, { timeout: 10_000 });
      } finally {
        await side.$disconnect();
      }

      const [a, w] = await Promise.all([accept!, withdrawal!]);
      expect(a.status).toBe(200);
      expect(w.status).toBe(409);
      expect(w.body).toEqual(BLOCKED);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } })).deletedAt).toBeNull();
    }, 20_000);
  });
});

/**
 * A request that passed `requireActiveUser` before a withdrawal committed must not write data back
 * into the withdrawn account. Each test holds the user's row, lets the request queue behind it,
 * then commits a soft deletion (what a withdrawal leaves) before releasing.
 */
describe('writes that overlap a withdrawal', () => {
  async function whileWithdrawing(user: User, send: () => PromiseLike<Answer>): Promise<Answer> {
    const side = sideClient();
    let pending: Promise<Answer> | undefined;
    try {
      await side.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
        pending = started(send());
        await waitForLockWaiters(side, 1);
        await tx.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), name: '탈퇴한 회원', bio: null } });
      }, { timeout: 10_000 });
    } finally {
      await side.$disconnect();
    }
    return pending!;
  }

  const INACTIVE = { error: { message: 'Account is no longer active' } };

  it('a profile update writes nothing back', async () => {
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user).patch('/api/users/me').send({ bio: '되살아난 소개' }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(INACTIVE);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).bio).toBeNull();
  });

  it('a profile update whose write lands just before the withdrawal answers 401, not the scrubbed profile', async () => {
    const user = await makeFreelancer();
    // Deterministic stand-in for the race: the withdrawal commits right after the conditional write
    // succeeds and before the profile is read back.
    const updateMany = prisma.user.updateMany.bind(prisma.user);
    const spy = vi.spyOn(prisma.user, 'updateMany').mockImplementation((async (args: Parameters<typeof updateMany>[0]) => {
      const written = await updateMany(args);
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), name: '탈퇴한 회원', bio: null } });
      return written;
    }) as unknown as typeof prisma.user.updateMany);

    try {
      const res = await authed(user).patch('/api/users/me').send({ bio: '탈퇴 직전 소개' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INACTIVE);
    } finally {
      spy.mockRestore();
    }
  });

  it('a portfolio item is not created, and its uploaded image goes to the file cleanup', async () => {
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user)
      .post('/api/users/me/portfolio')
      .field('title', '늦게 도착한 항목')
      .attach('image', PNG, { filename: 'late.png', contentType: 'image/png' }));

    expect(res.status).toBe(401);
    expect(await prisma.portfolioItem.count({ where: { userId: user.id } })).toBe(0);
    const [job] = await jobsOf('account.deletePublicFiles');
    const [path] = (job.payload as { paths: string[] }).paths;
    expect(path).toMatch(/^portfolio\//);
    await runDueJobs({ now: new Date(Date.now() + 1000), types: ['account.deletePublicFiles'] });
    expect(storage.has(PUBLIC, path)).toBe(false);
  });

  it('a career is not created', async () => {
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user).post('/api/users/me/careers').send({
      company: '회사', position: '개발자', employmentType: 'FULL_TIME', startDate: '2024-01', endDate: null,
    }));

    expect(res.status).toBe(401);
    expect(await prisma.career.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a payout account is not registered', async () => {
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user).put('/api/users/me/payout-account').send({
      bankCode: '004', accountNumber: '110123456789', holderName: user.name,
    }));

    expect(res.status).toBe(401);
    expect(await prisma.payoutAccount.count({ where: { userId: user.id } })).toBe(0);
  });

  it('notification settings are not saved', async () => {
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user).put('/api/notifications/preferences').send({
      preferences: [{ type: 'PROJECT_STATUS_CHANGED', inApp: false }],
    }));

    expect(res.status).toBe(401);
    expect(await prisma.notificationPreference.count({ where: { userId: user.id } })).toBe(0);
  });

  it('an application is not created', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { status: 'OPEN' });
    const user = await makeFreelancer();

    const res = await whileWithdrawing(user, () => authed(user).post(`/api/projects/${project.id}/applications`).send({
      coverLetter: '열심히 하겠습니다. 경험이 많습니다.', expectedRate: 1_000_000, expectedDuration: '1개월',
    }));

    expect(res.status).toBe(401);
    expect(await prisma.application.count({ where: { freelancerId: user.id } })).toBe(0);
  });
});
