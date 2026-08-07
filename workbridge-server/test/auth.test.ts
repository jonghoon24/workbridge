import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

// `googleCallback` reaches Google over axios. Mocked at the module boundary so no test can
// make a real network call; every test sets the responses it expects.
vi.mock('axios', () => {
  const post = vi.fn();
  const get = vi.fn();
  return { default: { post, get } };
});

import axios from 'axios';

import { api, authed, tokenFor } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeUser, TEST_PASSWORD } from './helpers/factories';
import { generateRefreshToken } from '../src/lib/jwt';
import type { JwtUserPayload } from '../src/types/index';

// ---------------------------------------------------------------------------
// Local helpers (kept in this file on purpose — the shared harness is off limits)
// ---------------------------------------------------------------------------

/** `axios.post`/`axios.get` are typed to return a full `AxiosResponse`; the mocks return stubs. */
const axiosPost = axios.post as unknown as Mock;
const axiosGet = axios.get as unknown as Mock;

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET as string;
const CLIENT_URL = process.env.CLIENT_URL as string;

/** Supertest types `headers` loosely; narrow it here rather than sprinkling casts. */
type WithHeaders = { headers: Record<string, unknown> };

function setCookies(res: WithHeaders): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function refreshCookie(res: WithHeaders): string | undefined {
  return setCookies(res).find((c) => c.startsWith('refreshToken='));
}

/** The JWT out of the `refreshToken` cookie, so the claims it carries can be asserted. */
function refreshCookieToken(res: WithHeaders): string {
  const cookie = refreshCookie(res);
  if (!cookie) throw new Error(`no refreshToken cookie in ${JSON.stringify(setCookies(res))}`);
  return decodeURIComponent(cookie.slice('refreshToken='.length).split(';')[0]);
}

function claims(token: string, secret: string = ACCESS_SECRET): JwtUserPayload {
  return jwt.verify(token, secret) as JwtUserPayload;
}

/** A Google userinfo payload; `verified_email` is what a real Google response carries. */
const googleProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'google-uid-1',
  email: 'gmail.person@test.local',
  name: 'Google Person',
  picture: 'https://lh3.googleusercontent.com/pic.jpg',
  verified_email: true,
  ...overrides,
});

/** Stubs the two upstream calls `googleCallback` makes, in order. */
function stubGoogle(profile: Record<string, unknown> = googleProfile()) {
  axiosPost.mockResolvedValue({ data: { access_token: 'ya29.stub-access-token' } });
  axiosGet.mockResolvedValue({ data: profile });
}

let consoleError: { mockRestore: () => void };

beforeEach(() => {
  axiosPost.mockReset();
  axiosGet.mockReset();
  // Several tests deliberately drive the 500 path and the OAuth failure path, both of which
  // log. Silenced so the run output stays readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

// ---------------------------------------------------------------------------
// POST /api/auth/signup
// ---------------------------------------------------------------------------

describe('POST /api/auth/signup', () => {
  const valid = {
    email: 'newuser@test.local',
    password: 's3cret-password',
    name: 'New User',
    role: 'CLIENT',
  };

  it.each([
    ['email', { ...valid, email: undefined }],
    ['password', { ...valid, password: undefined }],
    ['name', { ...valid, name: undefined }],
    ['role', { ...valid, role: undefined }],
  ])('rejects a request missing %s with 400', async (_field, body) => {
    const res = await api().post('/api/auth/signup').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'All fields are required' } });
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects an empty body with 400', async () => {
    const res = await api().post('/api/auth/signup').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('All fields are required');
  });

  it('rejects a role outside CLIENT|FREELANCER with 400', async () => {
    const res = await api().post('/api/auth/signup').send({ ...valid, role: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Role must be CLIENT or FREELANCER' } });
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects a lowercase role with 400 — the enum is case-sensitive', async () => {
    const res = await api().post('/api/auth/signup').send({ ...valid, role: 'client' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Role must be CLIENT or FREELANCER');
  });

  it('rejects a duplicate email with 409 and creates no second row', async () => {
    const existing = await makeUser({ email: 'taken@test.local' });

    const res = await api()
      .post('/api/auth/signup')
      .send({ ...valid, email: existing.email });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Email already in use' } });
    expect(await prisma.user.count()).toBe(1);
  });

  it('creates the user and responds 201 with the documented shape', async () => {
    const res = await api().post('/api/auth/signup').send(valid);

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: valid.email,
      name: valid.name,
      role: 'CLIENT',
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: valid.email } });
    expect(stored.id).toBe(res.body.user.id);
    expect(stored.role).toBe('CLIENT');
    expect(stored.deletedAt).toBeNull();
  });

  it('issues an access token carrying exactly { id, email, role }', async () => {
    const res = await api().post('/api/auth/signup').send(valid);

    const decoded = claims(res.body.accessToken);
    expect(decoded.id).toBe(res.body.user.id);
    expect(decoded.email).toBe(valid.email);
    expect(decoded.role).toBe('CLIENT');
    expect(Object.keys(decoded).sort()).toEqual(['email', 'exp', 'iat', 'id', 'role']);
  });

  it('stores the password bcrypt-hashed, never in plaintext', async () => {
    const res = await api().post('/api/auth/signup').send(valid);
    expect(res.status).toBe(201);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: valid.email } });
    expect(stored.password).not.toBeNull();
    expect(stored.password).not.toBe(valid.password);
    expect(stored.password).not.toContain(valid.password);
    expect(stored.password).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt modular crypt format
    expect(await bcrypt.compare(valid.password, stored.password as string)).toBe(true);
  });

  it('never leaks the password hash in the response', async () => {
    const res = await api().post('/api/auth/signup').send(valid);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: valid.email } });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(stored.password);
    expect(body).not.toContain(valid.password);
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('sets an httpOnly refreshToken cookie that verifies against the refresh secret', async () => {
    const res = await api().post('/api/auth/signup').send(valid);

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=604800/); // 7 days

    const decoded = claims(refreshCookieToken(res), REFRESH_SECRET);
    expect(decoded.id).toBe(res.body.user.id);
    expect(decoded.email).toBe(valid.email);
    expect(decoded.role).toBe('CLIENT');
  });

  it('gives the access token a 15-minute and the refresh token a 7-day lifetime', async () => {
    const res = await api().post('/api/auth/signup').send(valid);

    const access = claims(res.body.accessToken);
    const refreshed = claims(refreshCookieToken(res), REFRESH_SECRET);
    expect((access.exp as number) - (access.iat as number)).toBe(15 * 60);
    expect((refreshed.exp as number) - (refreshed.iat as number)).toBe(7 * 24 * 60 * 60);
  });

  it('accepts FREELANCER as well', async () => {
    const res = await api()
      .post('/api/auth/signup')
      .send({ ...valid, role: 'FREELANCER' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('FREELANCER');
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: valid.email } });
    expect(stored.role).toBe('FREELANCER');
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('rejects a missing email with 400', async () => {
    const res = await api().post('/api/auth/login').send({ password: TEST_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Email and password are required' } });
  });

  it('rejects a missing password with 400', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'someone@test.local' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Email and password are required');
  });

  it('rejects an unknown email with 401 Invalid credentials', async () => {
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Invalid credentials' } });
  });

  it('rejects a password-less OAuth-only account with 401 Invalid credentials', async () => {
    const oauthOnly = await makeUser({ password: null, googleId: 'google-oauth-only' });

    const res = await api()
      .post('/api/auth/login')
      .send({ email: oauthOnly.email, password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Invalid credentials' } });
  });

  it('rejects a wrong password with 401 Invalid credentials', async () => {
    const user = await makeUser();

    const res = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'definitely-not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Invalid credentials' } });
  });

  it('returns an identical response for unknown email, no password, and wrong password', async () => {
    const oauthOnly = await makeUser({ password: null, googleId: 'google-enum-probe' });
    const withPassword = await makeUser();

    const unknown = await api()
      .post('/api/auth/login')
      .send({ email: 'nobody-here@test.local', password: TEST_PASSWORD });
    const noPassword = await api()
      .post('/api/auth/login')
      .send({ email: oauthOnly.email, password: TEST_PASSWORD });
    const wrongPassword = await api()
      .post('/api/auth/login')
      .send({ email: withPassword.email, password: 'wrong' });

    // Indistinguishable, so the endpoint cannot be used to enumerate accounts.
    for (const res of [unknown, noPassword, wrongPassword]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: 'Invalid credentials' } });
      expect(refreshCookie(res)).toBeUndefined();
    }
    expect(noPassword.body).toEqual(unknown.body);
    expect(wrongPassword.body).toEqual(unknown.body);
  });

  it('logs a valid user in with 200, the user payload, and a refreshed cookie', async () => {
    const user = await makeClient();

    const res = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(res.body.user).toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'CLIENT',
    });
    expect(JSON.stringify(res.body)).not.toContain(user.password);

    expect(refreshCookie(res)).toMatch(/HttpOnly/i);
    expect(claims(refreshCookieToken(res), REFRESH_SECRET).id).toBe(user.id);
    expect(claims(res.body.accessToken)).toMatchObject({
      id: user.id,
      email: user.email,
      role: 'CLIENT',
    });
  });

  it('issues a token that authenticates a protected route', async () => {
    const user = await makeFreelancer();

    const login = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    const me = await api()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout', () => {
  it('clears the refreshToken cookie and returns 200', async () => {
    const user = await makeUser();

    const res = await authed(user).post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out successfully' });

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/refreshToken=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('leaves the already-issued access token valid — tokens are stateless by design [Q1]', async () => {
    const user = await makeUser();
    const token = tokenFor(user);

    await api().post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    const after = await api().get('/api/users/me').set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(200);
    expect(after.body.id).toBe(user.id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------

describe('POST /api/auth/refresh', () => {
  it('rejects a request with no cookie with 401', async () => {
    const res = await api().post('/api/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Refresh token not found' } });
  });

  it('rejects a garbage token with 401', async () => {
    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', 'refreshToken=not-a-jwt');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Invalid or expired refresh token' } });
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const user = await makeUser();
    const forged = jwt.sign({ id: user.id, email: user.email, role: user.role }, 'wrong_secret');

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired refresh token');
  });

  it('rejects a token signed with the ACCESS secret with 401 — the secrets are separate', async () => {
    const user = await makeUser();
    const accessToken = tokenFor(user);

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${accessToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired refresh token');
  });

  it('rejects an expired refresh token with 401', async () => {
    const user = await makeUser();
    const expired = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      REFRESH_SECRET,
      { expiresIn: '-1s' },
    );

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired refresh token');
  });

  it('rejects a valid token whose user no longer exists with 401 User not found', async () => {
    const token = generateRefreshToken({
      id: randomUUID(),
      email: 'ghost@test.local',
      role: 'CLIENT',
    });

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('returns a new accessToken and nothing else on success', async () => {
    const user = await makeClient();
    const token = generateRefreshToken({ id: user.id, email: user.email, role: user.role });

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['accessToken']);
    expect(claims(res.body.accessToken)).toMatchObject({
      id: user.id,
      email: user.email,
      role: 'CLIENT',
    });
  });

  it('does not rotate the refresh token — by design [Q1]', async () => {
    const user = await makeUser();
    const token = generateRefreshToken({ id: user.id, email: user.email, role: user.role });

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toBeUndefined();

    // The original cookie therefore keeps working.
    const again = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);
    expect(again.status).toBe(200);
  });

  it('mints an access token that authenticates a protected route', async () => {
    const user = await makeFreelancer();
    const token = generateRefreshToken({ id: user.id, email: user.email, role: user.role });

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);
    const me = await api()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
  });

  it('reflects the current role, not the role in the refresh token', async () => {
    // The refresh token's claims are ignored beyond `id`: the new access token is built
    // from the freshly-read user row.
    const user = await makeUser({ role: 'FREELANCER', roleSelected: false });
    const token = generateRefreshToken({ id: user.id, email: user.email, role: 'FREELANCER' });
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'CLIENT', roleSelected: true },
    });

    const res = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);

    expect(res.status).toBe(200);
    expect(claims(res.body.accessToken).role).toBe('CLIENT');
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/select-role
// ---------------------------------------------------------------------------

describe('POST /api/auth/select-role', () => {
  it('rejects a missing role with 400', async () => {
    const user = await makeUser({ roleSelected: false });

    const res = await authed(user).post('/api/auth/select-role').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Role must be CLIENT or FREELANCER' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.roleSelected).toBe(false);
  });

  it('rejects an invalid role with 400', async () => {
    const user = await makeUser({ roleSelected: false });

    const res = await authed(user).post('/api/auth/select-role').send({ role: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Role must be CLIENT or FREELANCER');
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe('FREELANCER');
    expect(stored.roleSelected).toBe(false);
  });

  it('returns 404 when the token identifies a user that does not exist', async () => {
    const res = await authed({
      id: randomUUID(),
      email: 'ghost@test.local',
      role: 'FREELANCER',
    })
      .post('/api/auth/select-role')
      .send({ role: 'CLIENT' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('rejects a second selection with 400 and leaves the role untouched', async () => {
    const user = await makeUser({ role: 'FREELANCER', roleSelected: true });

    const res = await authed(user).post('/api/auth/select-role').send({ role: 'CLIENT' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Role has already been selected' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe('FREELANCER');
  });

  it('sets the role, marks roleSelected, and returns the updated user', async () => {
    const user = await makeUser({ role: 'FREELANCER', roleSelected: false });

    const res = await authed(user).post('/api/auth/select-role').send({ role: 'CLIENT' });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(res.body.user).toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'CLIENT',
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe('CLIENT');
    expect(stored.roleSelected).toBe(true);
  });

  it('re-issues both tokens so the new role appears in the claims', async () => {
    const user = await makeUser({ role: 'FREELANCER', roleSelected: false });

    const res = await authed(user).post('/api/auth/select-role').send({ role: 'CLIENT' });

    expect(claims(res.body.accessToken)).toMatchObject({ id: user.id, role: 'CLIENT' });
    expect(claims(refreshCookieToken(res), REFRESH_SECRET)).toMatchObject({
      id: user.id,
      role: 'CLIENT',
    });
    expect(refreshCookie(res)).toMatch(/HttpOnly/i);
  });

  it('re-issued token satisfies role gating for the new role', async () => {
    const user = await makeUser({ role: 'FREELANCER', roleSelected: false });

    const before = await authed(user).get('/api/users/me/projects'); // CLIENT-only
    expect(before.status).toBe(403);

    const res = await authed(user).post('/api/auth/select-role').send({ role: 'CLIENT' });
    const after = await api()
      .get('/api/users/me/projects')
      .set('Authorization', `Bearer ${res.body.accessToken}`);

    expect(after.status).toBe(200);
  });

  it('is one-way: it cannot be reused to switch roles later', async () => {
    const user = await makeUser({ role: 'FREELANCER', roleSelected: false });

    const first = await authed(user).post('/api/auth/select-role').send({ role: 'CLIENT' });
    expect(first.status).toBe(200);

    const second = await api()
      .post('/api/auth/select-role')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ role: 'FREELANCER' });

    expect(second.status).toBe(400);
    expect(second.body.error.message).toBe('Role has already been selected');
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe('CLIENT');
  });

  it('is unavailable to a password signup, which has already chosen its role', async () => {
    const signup = await api().post('/api/auth/signup').send({
      email: 'chooser@test.local',
      password: 'a-password',
      name: 'Chooser',
      role: 'CLIENT',
    });
    expect(signup.status).toBe(201);

    const res = await api()
      .post('/api/auth/select-role')
      .set('Authorization', `Bearer ${signup.body.accessToken}`)
      .send({ role: 'FREELANCER' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Role has already been selected');
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/google
// ---------------------------------------------------------------------------

describe('GET /api/auth/google', () => {
  it('redirects to the Google consent screen with the documented parameters', async () => {
    const res = await api().get('/api/auth/google');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
    });
  });

  it('returns a 500 error response — not a crash — when Google env vars are missing', async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const res = await api().get('/api/auth/google');

      expect(res.status).toBe(500);
      expect(res.body.error.message).toMatch(/GOOGLE_CLIENT_ID/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
    }

    // The process is still serving requests.
    expect((await api().get('/health')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback
// ---------------------------------------------------------------------------

describe('GET /api/auth/google/callback', () => {
  const oauthFailed = `${CLIENT_URL}/login?error=oauth_failed`;

  it('redirects with error=oauth_failed when code is missing, without calling Google', async () => {
    const res = await api().get('/api/auth/google/callback');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(oauthFailed);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(0);
  });

  it('creates a brand-new Google user as FREELANCER with roleSelected false', async () => {
    stubGoogle();

    const res = await api().get('/api/auth/google/callback?code=auth-code-123');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(`${CLIENT_URL}/auth/callback`);
    expect(location.searchParams.get('needsRoleSelection')).toBe('true');

    const stored = await prisma.user.findUniqueOrThrow({
      where: { email: 'gmail.person@test.local' },
    });
    expect(stored.role).toBe('FREELANCER');
    expect(stored.roleSelected).toBe(false);
    expect(stored.googleId).toBe('google-uid-1');
    expect(stored.name).toBe('Google Person');
    expect(stored.profileImage).toBe('https://lh3.googleusercontent.com/pic.jpg');
    expect(stored.password).toBeNull();

    expect(claims(location.searchParams.get('token') as string)).toMatchObject({
      id: stored.id,
      email: stored.email,
      role: 'FREELANCER',
    });
    expect(refreshCookie(res)).toMatch(/HttpOnly/i);
    expect(claims(refreshCookieToken(res), REFRESH_SECRET).id).toBe(stored.id);
  });

  it('exchanges the code and fetches the profile with the returned access token', async () => {
    stubGoogle();

    await api().get('/api/auth/google/callback?code=auth-code-123');

    expect(axiosPost).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ code: 'auth-code-123', grant_type: 'authorization_code' }),
    );
    expect(axiosGet).toHaveBeenCalledWith(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: 'Bearer ya29.stub-access-token' } },
    );
  });

  it('links an existing account matched by googleId and reports needsRoleSelection false', async () => {
    const existing = await makeFreelancer({
      email: 'linked@test.local',
      googleId: 'google-uid-1',
      roleSelected: true,
    });
    stubGoogle(googleProfile({ email: 'someone.else@test.local' }));

    const res = await api().get('/api/auth/google/callback?code=code');

    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('needsRoleSelection')).toBe('false');
    expect(claims(location.searchParams.get('token') as string).id).toBe(existing.id);
    expect(await prisma.user.count()).toBe(1); // no second account
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.email).toBe('linked@test.local'); // the Google email does not overwrite it
  });

  it('reports needsRoleSelection true for a linked account that has not chosen a role', async () => {
    await makeUser({ googleId: 'google-uid-1', roleSelected: false, password: null });
    stubGoogle(googleProfile({ email: 'unrelated@test.local' }));

    const res = await api().get('/api/auth/google/callback?code=code');

    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('needsRoleSelection')).toBe('true');
  });

  it('fills profileImage only when it is empty', async () => {
    const existing = await makeUser({
      googleId: 'google-uid-1',
      password: null,
      profileImage: null,
    });
    stubGoogle(googleProfile({ email: 'no-picture-yet@test.local' }));

    await api().get('/api/auth/google/callback?code=code');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.profileImage).toBe('https://lh3.googleusercontent.com/pic.jpg');
  });

  it('does not overwrite an existing profileImage', async () => {
    const existing = await makeUser({
      googleId: 'google-uid-1',
      password: null,
      profileImage: 'https://cdn.test.local/mine.png',
    });
    stubGoogle(googleProfile({ email: 'has-picture@test.local' }));

    await api().get('/api/auth/google/callback?code=code');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.profileImage).toBe('https://cdn.test.local/mine.png');
  });

  it('degrades to oauth_failed when the token exchange fails', async () => {
    axiosPost.mockRejectedValue(new Error('502 from Google'));

    const res = await api().get('/api/auth/google/callback?code=code');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(oauthFailed);
    expect(await prisma.user.count()).toBe(0);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('degrades to oauth_failed when the userinfo lookup fails', async () => {
    axiosPost.mockResolvedValue({ data: { access_token: 'ya29.stub' } });
    axiosGet.mockRejectedValue(new Error('401 invalid_token'));

    const res = await api().get('/api/auth/google/callback?code=code');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(oauthFailed);
    expect(await prisma.user.count()).toBe(0);
  });

  it('degrades to oauth_failed when the profile has no email to persist', async () => {
    stubGoogle({ id: 'google-uid-1', name: 'No Email' });

    const res = await api().get('/api/auth/google/callback?code=code');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(oauthFailed);
    expect(await prisma.user.count()).toBe(0);
  });

  it('does not resurrect a soft-deleted account, and degrades to oauth_failed', async () => {
    // The lookup filters `deletedAt: null`, so the deleted row is invisible — but `email`
    // is still unique, so the create collides. That must not become a 500 or a session.
    const deleted = await makeUser({
      email: 'gmail.person@test.local',
      deletedAt: new Date(),
    });
    stubGoogle();

    const res = await api().get('/api/auth/google/callback?code=code');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(oauthFailed);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: deleted.id } });
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.googleId).toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });

  // [D5] An existing password account is matched by email alone and has `googleId` attached,
  // so anyone who knows the address can sign in as that user through Google. Asserted with
  // `verified_email: false` so no linking mechanism — not even trusting Google's own verified
  // flag — could justify the link. Today the account is linked and a token is issued for it.
  it.fails('does not link a password account on an unverified Google email [D5]', async () => {
    const victim = await makeClient({ email: 'victim@test.local' });
    stubGoogle(googleProfile({ id: 'attacker-google-uid', email: victim.email, verified_email: false }));

    const res = await api().get('/api/auth/google/callback?code=code');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(stored.googleId).toBeNull();
    expect(res.headers.location).not.toContain('/auth/callback');
  });

  // [D5] Same defect stated as the session it hands out: even with `verified_email: true`,
  // Google's assertion is about the Google account, not about control of a pre-existing
  // WorkBridge password account, so linking must be an explicit, authenticated action.
  // Today the redirect carries an access token whose `id` is the password account's.
  it.fails('does not issue a session for a pre-existing password account [D5]', async () => {
    const victim = await makeClient({ email: 'victim2@test.local' });
    stubGoogle(googleProfile({ id: 'attacker-google-uid-2', email: victim.email }));

    const res = await api().get('/api/auth/google/callback?code=code');

    const location = new URL(res.headers.location as string);
    const token = location.searchParams.get('token');
    expect(token === null || claims(token).id !== victim.id).toBe(true);
  });
});
