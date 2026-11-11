import { afterEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, TEST_PASSWORD } from './helpers/factories';
import { invalidBodyFor } from './helpers/errors';
import type { RefreshTokenPayload } from '../src/types/index';

/**
 * `POST /api/auth/change-password` (docs/domain/accounts.md "비밀번호 변경"): the current password
 * is re-checked, the new one follows the signup rule, other devices' refresh tokens stop working
 * while this device gets new tokens, and wrong current passwords are rate-limited per account.
 * 401 and the soft-deleted caller are covered by the authorization and soft-delete matrices.
 */

const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET as string;
const NEW_PASSWORD = 'brand-new-password';
const TOO_MANY = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } };

afterEach(() => {
  process.env.RATE_LIMIT_ENABLED = 'true';
});

type WithHeaders = { headers: Record<string, unknown> };

function refreshCookieToken(res: WithHeaders): string | undefined {
  const raw = res.headers['set-cookie'];
  const cookies = raw === undefined ? [] : Array.isArray(raw) ? (raw as string[]) : [raw as string];
  const cookie = cookies.find((c) => c.startsWith('refreshToken='));
  return cookie ? decodeURIComponent(cookie.slice('refreshToken='.length).split(';')[0]) : undefined;
}

/** Logs in through the real route and returns the refresh token it set — "another device". */
async function loginRefreshToken(email: string, password: string): Promise<string> {
  const res = await api().post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const token = refreshCookieToken(res);
  if (!token) throw new Error('login set no refresh cookie');
  return token;
}

function refresh(token: string) {
  return api().post('/api/auth/refresh').set('Cookie', `refreshToken=${token}`);
}

function change(user: Parameters<typeof authed>[0], body: Record<string, unknown>) {
  return authed(user).post('/api/auth/change-password').send(body);
}

/** Fixed 15-minute windows: wait out a boundary that is a few seconds away (see rate-limit.test.ts). */
async function awayFromWindowEdge(marginMs = 5_000) {
  const windowMs = 15 * 60_000;
  const untilEdge = windowMs - (Date.now() % windowMs);
  if (untilEdge < marginMs) await new Promise((resolve) => setTimeout(resolve, untilEdge + 50));
}

describe('POST /api/auth/change-password', () => {
  it('changes the password and answers with a new access token and refresh cookie', async () => {
    const user = await makeFreelancer();
    const before = Date.now();

    const res = await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['accessToken']);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, stored.password as string)).toBe(true);
    expect(stored.passwordChangedAt?.getTime()).toBeGreaterThanOrEqual(before - 1);

    const cookie = refreshCookieToken(res);
    expect(cookie).toBeDefined();
    const decoded = jwt.verify(cookie as string, REFRESH_SECRET) as RefreshTokenPayload;
    expect(decoded).toMatchObject({ id: user.id, pwdChangedAt: stored.passwordChangedAt?.getTime() });
  });

  it('logs in with the new password only', async () => {
    const user = await makeClient();

    await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const oldLogin = await api().post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    const newLogin = await api().post('/api/auth/login').send({ email: user.email, password: NEW_PASSWORD });
    expect(oldLogin.status).toBe(401);
    expect(oldLogin.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } });
    expect(newLogin.status).toBe(200);
  });

  it('ends other sessions: a refresh token from before the change no longer refreshes', async () => {
    const user = await makeFreelancer();
    const otherDevice = await loginRefreshToken(user.email, TEST_PASSWORD);
    expect((await refresh(otherDevice)).status).toBe(200);

    const res = await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const refused = await refresh(otherDevice);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'Invalid or expired refresh token' } });
  });

  it('keeps this device signed in: the returned tokens work', async () => {
    const user = await makeFreelancer();

    const res = await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const refreshed = await refresh(refreshCookieToken(res) as string);
    expect(refreshed.status).toBe(200);
    const me = await api().get('/api/users/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
  });

  it('accepts a session started after the change', async () => {
    const user = await makeClient();
    await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const later = await loginRefreshToken(user.email, NEW_PASSWORD);

    expect((await refresh(later)).status).toBe(200);
  });

  // Access tokens are stateless, as after logout: the risk is bounded by their short lifetime.
  it('leaves an access token issued before the change valid until it expires', async () => {
    const user = await makeFreelancer();
    const login = await api().post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD });

    await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const me = await api().get('/api/users/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it.each([
    [{}, 'currentPassword: Current password is required', 'REQUIRED'],
    [{ currentPassword: TEST_PASSWORD }, 'newPassword: New password is required', 'REQUIRED'],
    [{ currentPassword: TEST_PASSWORD, newPassword: 'short' }, 'newPassword: Password must be at least 8 characters', 'TOO_SMALL'],
    [{ currentPassword: TEST_PASSWORD, newPassword: 12345678 }, 'newPassword: New password must be a string', 'INVALID'],
    [
      { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      'newPassword: New password must be different from the current password',
      'CONFLICT',
    ],
  ] as const)('rejects %j with 400 and changes nothing', async (body, message, code) => {
    const user = await makeClient();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const res = await change(user, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBodyFor(code, message));
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.password).toBe(before.password);
    expect(stored.passwordChangedAt).toBeNull();
  });

  it('rejects a wrong current password with 400, not 401, and changes nothing', async () => {
    const user = await makeFreelancer();
    const otherDevice = await loginRefreshToken(user.email, TEST_PASSWORD);

    const res = await change(user, { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(TEST_PASSWORD, stored.password as string)).toBe(true);
    expect(stored.passwordChangedAt).toBeNull();
    expect((await refresh(otherDevice)).status).toBe(200);
  });

  it('refuses an account that signs in with Google only (no password) with 409', async () => {
    const user = await makeFreelancer({ password: null, googleId: 'google-only-uid' });

    const res = await change(user, { currentPassword: 'anything-at-all', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'PASSWORD_NOT_SET', message: 'Account has no password' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.password).toBeNull();
    expect(stored.passwordChangedAt).toBeNull();
    expect(await prisma.rateLimitCounter.count()).toBe(0); // not counted as a wrong password
  });

  it('lets exactly one of two concurrent changes win', async () => {
    const user = await makeClient();

    const results = await Promise.all([
      change(user, { currentPassword: TEST_PASSWORD, newPassword: 'first-new-password' }),
      change(user, { currentPassword: TEST_PASSWORD, newPassword: 'second-new-password' }),
    ]);

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200);
    // The loser either lost the conditional write or already read the winner's hash.
    expect([
      { status: 409, body: { error: { code: 'PASSWORD_ALREADY_CHANGED', message: 'Password has already been changed' } } },
      { status: 400, body: { error: { code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' } } },
    ]).toContainEqual({ status: loser?.status, body: loser?.body });

    const winnerPassword = results[0].status === 200 ? 'first-new-password' : 'second-new-password';
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(winnerPassword, stored.password as string)).toBe(true);
  });

  describe('wrong current password limit', () => {
    it('refuses even the right password once five wrong ones were counted', async () => {
      await awayFromWindowEdge();
      const user = await makeFreelancer();

      for (let i = 0; i < 5; i += 1) {
        const wrong = await change(user, { currentPassword: `wrong-${i}`, newPassword: NEW_PASSWORD });
        expect(wrong.status).toBe(400);
      }
      const res = await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(429);
      expect(res.body).toEqual(TOO_MANY);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.passwordChangedAt).toBeNull();
    });

    it('counts per account: another user is not limited', async () => {
      await awayFromWindowEdge();
      const limited = await makeFreelancer();
      const other = await makeFreelancer();
      for (let i = 0; i < 5; i += 1) {
        await change(limited, { currentPassword: `wrong-${i}`, newPassword: NEW_PASSWORD });
      }

      const res = await change(other, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
    });

    it('clears the count after a successful change', async () => {
      await awayFromWindowEdge();
      const user = await makeClient();
      for (let i = 0; i < 4; i += 1) {
        await change(user, { currentPassword: `wrong-${i}`, newPassword: NEW_PASSWORD });
      }
      expect((await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);

      // Four more wrong tries are all 400s again, not 429s.
      for (let i = 0; i < 4; i += 1) {
        const wrong = await change(user, { currentPassword: `wrong-again-${i}`, newPassword: 'another-new-one' });
        expect(wrong.status).toBe(400);
      }
    });

    it('is not enforced when RATE_LIMIT_ENABLED=false', async () => {
      process.env.RATE_LIMIT_ENABLED = 'false';
      const user = await makeFreelancer();
      for (let i = 0; i < 6; i += 1) {
        await change(user, { currentPassword: `wrong-${i}`, newPassword: NEW_PASSWORD });
      }

      const res = await change(user, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
    });
  });
});
