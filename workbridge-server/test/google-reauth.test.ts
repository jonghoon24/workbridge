import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import jwt from 'jsonwebtoken';

// The callback reaches Google over axios. Mocked at the module boundary so no test can make a real
// network call; every test sets the responses it expects.
vi.mock('axios', () => {
  const post = vi.fn();
  const get = vi.fn();
  return { default: { post, get } };
});

import axios from 'axios';

import { api, tokenFor } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeUser } from './helpers/factories';
import { logger } from '../src/lib/logger';
import { issueReauthProof, REAUTH_AUDIENCE, verifyReauthProof } from '../src/lib/reauth';

/**
 * Google re-authentication: `GET /api/auth/google/reauth` and the callback's re-authentication branch
 * (docs/domain/accounts.md "Google 재인증"). What the proof unlocks is in `withdrawal.test.ts`.
 */

const axiosPost = axios.post as unknown as Mock;
const axiosGet = axios.get as unknown as Mock;

const CLIENT_URL = process.env.CLIENT_URL as string;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID as string;
const WITHDRAWAL_SCREEN = `${CLIENT_URL}/my/account/withdrawal`;
const MINUTE = 60;
const GOOGLE_SUB = 'google-sub-reauth';

type WithHeaders = { headers: Record<string, unknown> };

function setCookies(res: WithHeaders): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A Google ID token as the token endpoint returns it. Signed with an arbitrary key: the server reads
 * it without checking the signature (it came over TLS from Google), so only the claims matter.
 */
function idToken(overrides: Record<string, unknown> = {}): string {
  const now = nowSeconds();
  const claims: Record<string, unknown> = {
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    sub: GOOGLE_SUB,
    iat: now,
    exp: now + 60 * MINUTE,
    auth_time: now - 30,
    ...overrides,
  };
  for (const [key, value] of Object.entries(claims)) if (value === undefined) delete claims[key];
  return jwt.sign(claims, 'not-googles-key');
}

function stubGoogle(token: string = idToken()) {
  axiosPost.mockResolvedValue({ data: { access_token: 'ya29.stub', id_token: token } });
}

/** Starts a re-authentication and returns the `state` this browser's cookie now holds. */
async function startReauth(): Promise<string> {
  const res = await api().get('/api/auth/google/reauth?purpose=withdrawal');
  return new URL(res.headers.location).searchParams.get('state') as string;
}

/** Google's redirect back to the callback, from the browser that started the re-authentication. */
async function reauthCallback(query: Record<string, string> = { code: 'auth-code' }) {
  const state = await startReauth();
  const params = new URLSearchParams({ ...query, state });
  return api().get(`/api/auth/google/callback?${params.toString()}`).set('Cookie', `oauthState=${state}`);
}

/** The proof out of a successful callback's `#reauthToken=` fragment. */
function proofFrom(location: string): string {
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe(WITHDRAWAL_SCREEN);
  expect(url.search).toBe('');
  return new URLSearchParams(url.hash.slice(1)).get('reauthToken') as string;
}

const failure = (code: string) => `${WITHDRAWAL_SCREEN}?reauthError=${code}`;

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  axiosPost.mockReset();
  axiosGet.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  process.env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME = 'false';
});

function strictMode() {
  process.env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME = 'true';
}

// ---------------------------------------------------------------------------
// GET /api/auth/google/reauth
// ---------------------------------------------------------------------------

describe('GET /api/auth/google/reauth', () => {
  it('sends the browser to Google\'s account chooser asking for auth_time, with the documented parameters', async () => {
    const res = await api().get('/api/auth/google/reauth?purpose=withdrawal');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid',
      prompt: 'select_account',
      claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
      state: expect.any(String),
    });
  });

  it('keeps a fresh reauth state for its purpose in the same cookie as the login', async () => {
    const first = await api().get('/api/auth/google/reauth?purpose=withdrawal');
    const second = await api().get('/api/auth/google/reauth?purpose=withdrawal');

    const state = new URL(first.headers.location).searchParams.get('state') as string;
    expect(state).toMatch(/^reauth\.withdrawal\.[A-Za-z0-9_-]{43}$/);
    const cookie = setCookies(first).find((c) => c.startsWith('oauthState=')) as string;
    expect(cookie.split(';')[0]).toBe(`oauthState=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/google/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(new URL(second.headers.location).searchParams.get('state')).not.toBe(state);
  });

  it.each([
    ['no purpose', ''],
    ['an unknown purpose', '?purpose=payout_account'],
  ])('answers 400 for %s, without going to Google', async (_label, query) => {
    const res = await api().get(`/api/auth/google/reauth${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('purpose: Purpose must be one of: withdrawal');
    expect(setCookies(res).find((c) => c.startsWith('oauthState='))).toBeUndefined();
  });

  it('answers 500 before sending anyone to Google when CLIENT_URL is unset', async () => {
    const saved = process.env.CLIENT_URL;
    delete process.env.CLIENT_URL;
    try {
      const res = await api().get('/api/auth/google/reauth?purpose=withdrawal');

      expect(res.status).toBe(500);
      expect(res.headers.location).toBeUndefined();
      expect(consoleError.mock.calls.map((args: unknown[]) => String(args[0])).join('\n')).toMatch(/CLIENT_URL/);
    } finally {
      process.env.CLIENT_URL = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback — the re-authentication branch
// ---------------------------------------------------------------------------

describe('GET /api/auth/google/callback for a re-authentication', () => {
  it('returns to the withdrawal screen with a proof bound to the linked account, Google sign-in time and purpose', async () => {
    const user = await makeClient({ password: null, googleId: GOOGLE_SUB });
    const authTime = nowSeconds() - 30;
    stubGoogle(idToken({ auth_time: authTime }));

    const res = await reauthCallback();

    expect(res.status).toBe(302);
    const proof = proofFrom(res.headers.location);
    expect(verifyReauthProof(proof, new Date())).toEqual({
      userId: user.id,
      purpose: 'withdrawal',
      googleSub: GOOGLE_SUB,
      authTimeVerified: true,
    });
    // Accepted for a few minutes counted from the Google sign-in, not from now.
    const claims = jwt.decode(proof) as { exp: number; aud: string };
    expect(claims.exp).toBe(authTime + 5 * MINUTE);
    expect(claims.aud).toBe(REAUTH_AUDIENCE);
    expect(axiosPost).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ code: 'auth-code', grant_type: 'authorization_code' }),
    );
  });

  it('logs nobody in, creates no account and changes no profile', async () => {
    const user = await makeUser({ password: null, googleId: GOOGLE_SUB, profileImage: null });
    stubGoogle();

    const res = await reauthCallback();

    proofFrom(res.headers.location);
    const cookies = setCookies(res);
    expect(cookies.find((c) => c.startsWith('refreshToken='))).toBeUndefined();
    expect(cookies.find((c) => c.startsWith('oauthState='))).toMatch(/^oauthState=;/);
    expect(axiosGet).not.toHaveBeenCalled(); // no userinfo
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).profileImage).toBeNull();
  });

  describe('without auth_time from Google', () => {
    it('lax mode (the default): issues a proof marked unverified that expires a few minutes from now, and warns', async () => {
      const user = await makeClient({ password: null, googleId: GOOGLE_SUB });
      stubGoogle(idToken({ auth_time: undefined }));
      const warn = vi.spyOn(logger, 'warn');

      const before = nowSeconds();
      const res = await reauthCallback();

      const proof = proofFrom(res.headers.location);
      expect(verifyReauthProof(proof, new Date())).toEqual({
        userId: user.id,
        purpose: 'withdrawal',
        googleSub: GOOGLE_SUB,
        authTimeVerified: false,
      });
      const { exp } = jwt.decode(proof) as { exp: number };
      expect(exp).toBeGreaterThanOrEqual(before + 5 * MINUTE);
      expect(exp).toBeLessThanOrEqual(nowSeconds() + 5 * MINUTE);
      expect(warn).toHaveBeenCalledWith('google reauth without auth_time', { purpose: 'withdrawal' });
      expect(consoleError).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('strict mode: returns unavailable without a proof', async () => {
      strictMode();
      await makeClient({ password: null, googleId: GOOGLE_SUB });
      stubGoogle(idToken({ auth_time: undefined }));

      const res = await reauthCallback();

      expect(res.headers.location).toBe(failure('unavailable'));
    });
  });

  it('strict mode: issues a verified proof when Google gives a recent auth_time', async () => {
    strictMode();
    await makeClient({ password: null, googleId: GOOGLE_SUB });
    stubGoogle();

    const res = await reauthCallback();

    expect(verifyReauthProof(proofFrom(res.headers.location), new Date())?.authTimeVerified).toBe(true);
  });

  describe.each([
    ['lax', () => {}],
    ['strict', strictMode],
  ])('%s mode', (_mode, setMode) => {
    beforeEach(async () => {
      setMode();
      await makeClient({ password: null, googleId: GOOGLE_SUB });
    });

    it('returns stale when the Google sign-in is older than the window', async () => {
      stubGoogle(idToken({ auth_time: nowSeconds() - 6 * MINUTE }));

      expect((await reauthCallback()).headers.location).toBe(failure('stale'));
    });

    it('returns failed when auth_time is further in the future than clock drift explains', async () => {
      stubGoogle(idToken({ auth_time: nowSeconds() + 5 * MINUTE }));

      expect((await reauthCallback()).headers.location).toBe(failure('failed'));
    });
  });

  it.each([
    ['no linked account', async () => {}],
    ['a linked account that was withdrawn or deleted', () => makeClient({ password: null, googleId: GOOGLE_SUB, deletedAt: new Date() })],
  ])('returns account_mismatch for %s', async (_label, setup) => {
    await makeClient({ password: null, googleId: 'another-google-account' });
    await setup();
    stubGoogle();

    const res = await reauthCallback();

    expect(res.headers.location).toBe(failure('account_mismatch'));
  });

  it.each([
    ['an ID token for another client', () => stubGoogle(idToken({ aud: 'someone-elses-client' }))],
    ['an ID token from another issuer', () => stubGoogle(idToken({ iss: 'https://evil.example' }))],
    ['an expired ID token', () => stubGoogle(idToken({ exp: nowSeconds() - 1 }))],
    ['an ID token without a subject', () => stubGoogle(idToken({ sub: undefined }))],
    ['no ID token', () => axiosPost.mockResolvedValue({ data: { access_token: 'ya29.stub' } })],
    ['an unreadable ID token', () => stubGoogle('not-a-jwt')],
    ['a failed code exchange', () => axiosPost.mockRejectedValue(new Error('502 from Google'))],
  ])('returns failed on %s', async (_label, stub) => {
    await makeClient({ password: null, googleId: GOOGLE_SUB });
    stub();

    const res = await reauthCallback();

    expect(res.headers.location).toBe(failure('failed'));
    expect(setCookies(res).find((c) => c.startsWith('refreshToken='))).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user cancels at Google, without exchanging anything', async () => {
    const res = await reauthCallback({ error: 'access_denied' });

    expect(res.headers.location).toBe(failure('cancelled'));
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it.each([
    ['another Google error', { error: 'server_error' }],
    ['no code', {}],
  ])('returns failed on %s, without exchanging anything', async (_label, query) => {
    const res = await reauthCallback(query);

    expect(res.headers.location).toBe(failure('failed'));
    expect(axiosPost).not.toHaveBeenCalled();
  });

  // A re-authentication must never land on the login screen or the home page; a state that does not
  // match this browser's cookie only picks the screen to go back to.
  it.each([
    ['a different cookie', 'oauthState=reauth.withdrawal.someone-elses-state'],
    ['no cookie', null],
  ])('goes back to the withdrawal screen as failed when the state meets %s, issuing nothing', async (_label, cookie) => {
    await makeClient({ password: null, googleId: GOOGLE_SUB });
    stubGoogle();
    const state = 'reauth.withdrawal.attacker-state';

    const req = api().get(`/api/auth/google/callback?code=attacker-code&state=${state}`);
    const res = await (cookie ? req.set('Cookie', cookie) : req);

    expect(res.headers.location).toBe(failure('failed'));
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('treats a reauth-shaped state with an unknown purpose as a failed login', async () => {
    const state = 'reauth.payout_account.abc';

    const res = await api()
      .get(`/api/auth/google/callback?code=c&state=${state}`)
      .set('Cookie', `oauthState=${state}`);

    expect(res.headers.location).toBe(`${CLIENT_URL}/login?error=oauth_failed`);
    expect(axiosPost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The proof and the access token are not interchangeable
// ---------------------------------------------------------------------------

describe('the re-authentication proof', () => {
  it('is not accepted as an access token', async () => {
    const user = await makeClient({ password: null, googleId: GOOGLE_SUB });
    const proof = issueReauthProof({ userId: user.id, googleSub: GOOGLE_SUB, purpose: 'withdrawal', authTime: new Date() }, new Date());

    const res = await api().get('/api/users/me/withdrawal').set('Authorization', `Bearer ${proof}`);

    expect(res.status).toBe(401);
  });

  it('does not accept an access token, or a token signed with the access secret, as a proof', async () => {
    const user = await makeClient({ password: null, googleId: GOOGLE_SUB });
    const accessSigned = jwt.sign(
      { purpose: 'withdrawal', gsub: GOOGLE_SUB, authTimeVerified: true },
      process.env.JWT_ACCESS_SECRET as string,
      { audience: REAUTH_AUDIENCE, subject: user.id, expiresIn: '5m' },
    );
    const accessToken = tokenFor(user);

    expect(verifyReauthProof(accessSigned, new Date())).toBeNull();
    expect(verifyReauthProof(accessToken, new Date())).toBeNull();
  });
});
