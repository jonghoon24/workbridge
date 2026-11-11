import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import express from 'express';
import request from 'supertest';

import { api } from './helpers/api';
import { prisma } from './helpers/db';
import { makeUser, TEST_PASSWORD } from './helpers/factories';
import { hit, peek, reset } from '../src/lib/rateLimit';
import { LOGIN_IP_RULE } from '../src/lib/rateLimitRules';
import { clientIp } from '../src/lib/clientIp';
import { errorHandler } from '../src/middlewares/errorHandler';
import { rateLimit } from '../src/middlewares/rateLimit';

/**
 * Rate limiting — the limiter itself and `POST /api/auth/login`.
 * Counters live in a table that is truncated before every test, so each test starts at zero.
 */

const TOO_MANY = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } };

afterEach(() => {
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.PROXY_SHARED_SECRET = '';
  process.env.VERCEL = '';
});

/**
 * Fixed windows reset on 15-minute boundaries (every hour and KST-day boundary is one too), so
 * a test that straddled one would see its count restart. When a boundary is a few seconds
 * away, wait it out first.
 */
async function awayFromWindowEdge(marginMs = 5_000) {
  const windowMs = 15 * 60_000;
  const untilEdge = windowMs - (Date.now() % windowMs);
  if (untilEdge < marginMs) {
    await new Promise((resolve) => setTimeout(resolve, untilEdge + 50));
  }
}

function expectTooMany(res: { status: number; body: unknown; headers: Record<string, string> }, maxSeconds: number) {
  expect(res.status).toBe(429);
  expect(res.body).toEqual(TOO_MANY);
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(maxSeconds);
}

// ---------------------------------------------------------------------------------------------
// The counter itself
// ---------------------------------------------------------------------------------------------

describe('fixed-window counters', () => {
  it('aligns windows to KST boundaries and stores them as UTC instants', async () => {
    // 10:07:30 KST → the 15-minute window 10:00–10:15 KST.
    const now = new Date('2026-10-21T01:07:30.000Z');

    const result = await hit('t:align', 15 * 60_000, 3, now);

    expect(result).toEqual({ allowed: true, count: 1, remaining: 2, retryAfterSec: 450 });
    const [row] = await prisma.rateLimitCounter.findMany({ where: { key: 't:align' } });
    expect(row.windowStart.toISOString()).toBe('2026-10-21T01:00:00.000Z');
    expect(row.expiresAt.toISOString()).toBe('2026-10-21T01:15:00.000Z');
  });

  it('a day window starts at 00:00 KST', async () => {
    // 00:30 KST on 2026-10-22.
    const now = new Date('2026-10-21T15:30:00.000Z');

    const result = await hit('t:day', 86_400_000, 20, now);

    const [row] = await prisma.rateLimitCounter.findMany({ where: { key: 't:day' } });
    expect(row.windowStart.toISOString()).toBe('2026-10-21T15:00:00.000Z');
    expect(result.retryAfterSec).toBe(23.5 * 3600);
  });

  it('allows up to the limit; refused requests still count', async () => {
    const now = new Date();
    const counts = [];
    for (let i = 0; i < 5; i += 1) counts.push(await hit('t:limit', 60_000, 3, now));

    expect(counts.map((r) => [r.allowed, r.count, r.remaining])).toEqual([
      [true, 1, 2], [true, 2, 1], [true, 3, 0], [false, 4, 0], [false, 5, 0],
    ]);
  });

  it('never loses an increment under concurrency', async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 20 }, () => hit('t:race', 60_000, 100, now)));

    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a new window starts from zero', async () => {
    const t = new Date('2026-10-21T01:14:59.000Z');
    await hit('t:roll', 15 * 60_000, 1, t);
    expect((await hit('t:roll', 15 * 60_000, 1, t)).allowed).toBe(false);

    expect(await hit('t:roll', 15 * 60_000, 1, new Date('2026-10-21T01:15:00.000Z'))).toMatchObject({ allowed: true, count: 1 });
  });

  it('peek reads without counting; reset forgets every window of one key only', async () => {
    const now = new Date();
    expect(await peek('t:peek', 60_000, 2, now)).toMatchObject({ allowed: true, count: 0 });
    await hit('t:peek', 60_000, 2, now);
    await hit('t:peek', 60_000, 2, now);
    await hit('t:other', 60_000, 2, now);

    expect(await peek('t:peek', 60_000, 2, now)).toMatchObject({ allowed: false, count: 2 });
    expect(await peek('t:peek', 60_000, 2, now)).toMatchObject({ count: 2 });

    await reset('t:peek');
    expect(await peek('t:peek', 60_000, 2, now)).toMatchObject({ allowed: true, count: 0 });
    expect(await peek('t:other', 60_000, 2, now)).toMatchObject({ count: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------------------------

describe('POST /api/auth/login rate limits', () => {
  beforeEach(() => awayFromWindowEdge());

  const login = (body: Record<string, unknown>) => api().post('/api/auth/login').send(body);

  it('the 21st request from one IP in 15 minutes is a 429, whatever the earlier outcomes', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await login({})).status).toBe(400);
    }

    expectTooMany(await login({}), 15 * 60);
  });

  it('checks the IP limit before the required-field check', async () => {
    const user = await makeUser();
    for (let i = 0; i < 20; i += 1) await login({});

    // Even a correct login is refused once the IP is over the limit.
    expectTooMany(await login({ email: user.email, password: TEST_PASSWORD }), 15 * 60);
  });

  it('ignores X-Forwarded-For when TRUST_PROXY is unset', async () => {
    for (let i = 0; i < 20; i += 1) {
      await api().post('/api/auth/login').set('X-Forwarded-For', `203.0.113.${i}`).send({});
    }

    const res = await api().post('/api/auth/login').set('X-Forwarded-For', '198.51.100.7').send({});

    expectTooMany(res, 15 * 60);
  });

  it('after 5 failures for one email, even the correct password is a 429', async () => {
    const user = await makeUser();
    for (let i = 0; i < 5; i += 1) {
      const res = await login({ email: user.email, password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } });
    }

    expectTooMany(await login({ email: user.email, password: TEST_PASSWORD }), 15 * 60);
  });

  it('an unknown email is limited exactly like a known one, so the limiter cannot enumerate accounts', async () => {
    const user = await makeUser();
    const sequence = async (email: string) => {
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await login({ email, password: 'wrong-password' });
        statuses.push([res.status, res.body.error.message]);
      }
      return statuses;
    };

    const known = await sequence(user.email);
    const unknown = await sequence('nobody@test.local');

    expect(unknown).toEqual(known);
    expect(known.map(([status]) => status)).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('a successful login clears the failure count', async () => {
    const user = await makeUser();
    for (let i = 0; i < 4; i += 1) await login({ email: user.email, password: 'wrong-password' });

    expect((await login({ email: user.email, password: TEST_PASSWORD })).status).toBe(200);

    for (let i = 0; i < 5; i += 1) {
      expect((await login({ email: user.email, password: 'wrong-password' })).status).toBe(401);
    }
    expect((await login({ email: user.email, password: 'wrong-password' })).status).toBe(429);
  });

  it('keys failures on the trimmed, lowercased email', async () => {
    const user = await makeUser();
    const variants = [user.email, ` ${user.email}`, user.email.toUpperCase(), `${user.email} `, user.email];
    for (const email of variants) {
      expect((await login({ email, password: 'wrong-password' })).status).toBe(401);
    }

    expect((await login({ email: user.email, password: TEST_PASSWORD })).status).toBe(429);
  });

  it('one email\'s failures do not lock out another email', async () => {
    const victim = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < 5; i += 1) await login({ email: victim.email, password: 'wrong-password' });

    expect((await login({ email: other.email, password: TEST_PASSWORD })).status).toBe(200);
  });

  it('only 401s count as failures — a 400 does not', async () => {
    const user = await makeUser();
    for (let i = 0; i < 5; i += 1) {
      expect((await login({ email: user.email })).status).toBe(400);
    }

    expect((await login({ email: user.email, password: TEST_PASSWORD })).status).toBe(200);
  });

  it('RATE_LIMIT_ENABLED=false disables the limits, read per request', async () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    for (let i = 0; i < 25; i += 1) {
      expect((await login({})).status).toBe(400);
    }
    expect(await prisma.rateLimitCounter.count()).toBe(0);
  });
});

describe('client IP behind a trusted proxy', () => {
  beforeEach(() => awayFromWindowEdge());

  // `index.ts` reads TRUST_PROXY once at boot, so exercise the rule on a small app configured
  // the way local development is (`TRUST_PROXY=loopback`).
  const proxied = express();
  proxied.set('trust proxy', 'loopback');
  proxied.post('/limited', rateLimit(LOGIN_IP_RULE), (req, res) => res.json({ ip: req.ip }));
  proxied.use(errorHandler);

  it('counts each forwarded client address separately', async () => {
    const send = (ip: string) => request(proxied).post('/limited').set('X-Forwarded-For', ip);
    for (let i = 0; i < 20; i += 1) {
      expect((await send('203.0.113.10')).status).toBe(200);
    }

    expectTooMany(await send('203.0.113.10'), 15 * 60);
    const other = await send('203.0.113.11');
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ ip: '203.0.113.11' });
  });
});

describe('client IP from the Next.js proxy and the Vercel edge', () => {
  beforeEach(() => awayFromWindowEdge());

  const SECRET = 'proxy-secret-for-tests';
  const probe = express();
  probe.get('/ip', (req, res) => res.json({ ip: clientIp(req) }));
  const ipOf = async (headers: Record<string, string>) => {
    let req = request(probe).get('/ip');
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return (await req).body.ip as string;
  };
  const socketIp = async () => ipOf({});

  it('uses X-Client-IP when X-Proxy-Secret matches PROXY_SHARED_SECRET', async () => {
    process.env.PROXY_SHARED_SECRET = SECRET;

    expect(await ipOf({ 'X-Client-IP': '203.0.113.20', 'X-Proxy-Secret': SECRET })).toBe('203.0.113.20');
  });

  it('ignores X-Client-IP when the secret does not match, or is missing', async () => {
    process.env.PROXY_SHARED_SECRET = SECRET;
    const fallback = await socketIp();

    expect(await ipOf({ 'X-Client-IP': '203.0.113.21', 'X-Proxy-Secret': 'wrong' })).toBe(fallback);
    expect(await ipOf({ 'X-Client-IP': '203.0.113.21', 'X-Proxy-Secret': `${SECRET}x` })).toBe(fallback);
    expect(await ipOf({ 'X-Client-IP': '203.0.113.21' })).toBe(fallback);
  });

  it('ignores X-Client-IP when PROXY_SHARED_SECRET is unset, whatever the request claims', async () => {
    const fallback = await socketIp();

    expect(await ipOf({ 'X-Client-IP': '203.0.113.22', 'X-Proxy-Secret': '' })).toBe(fallback);
    expect(await ipOf({ 'X-Client-IP': '203.0.113.22', 'X-Proxy-Secret': 'anything' })).toBe(fallback);
  });

  it('ignores an X-Client-IP that is not an IP address, even with the secret', async () => {
    process.env.PROXY_SHARED_SECRET = SECRET;

    expect(await ipOf({ 'X-Client-IP': 'not-an-ip', 'X-Proxy-Secret': SECRET })).toBe(await socketIp());
  });

  it('on Vercel, falls back to X-Vercel-Forwarded-For, which the edge rewrites', async () => {
    process.env.VERCEL = '1';

    expect(await ipOf({ 'X-Vercel-Forwarded-For': '198.51.100.30' })).toBe('198.51.100.30');
    // A proxied request without the secret is keyed on what the edge saw, not on X-Client-IP.
    expect(await ipOf({ 'X-Vercel-Forwarded-For': '198.51.100.31', 'X-Client-IP': '203.0.113.23' }))
      .toBe('198.51.100.31');
  });

  it('off Vercel, X-Vercel-Forwarded-For is just another client header and is ignored', async () => {
    expect(await ipOf({ 'X-Vercel-Forwarded-For': '198.51.100.32' })).toBe(await socketIp());
  });

  it('keys the login limit on the proxied client IP: one browser at the limit does not block another', async () => {
    process.env.PROXY_SHARED_SECRET = SECRET;
    const loginFrom = (ip: string, secret = SECRET) => api().post('/api/auth/login')
      .set('X-Client-IP', ip).set('X-Proxy-Secret', secret).send({});
    for (let i = 0; i < 20; i += 1) {
      expect((await loginFrom('203.0.113.40')).status).toBe(400);
    }

    expectTooMany(await loginFrom('203.0.113.40'), 15 * 60);
    expect((await loginFrom('203.0.113.41')).status).toBe(400);
  });

  it('a forged X-Client-IP without the secret cannot dodge the login limit', async () => {
    process.env.PROXY_SHARED_SECRET = SECRET;
    for (let i = 0; i < 20; i += 1) {
      await api().post('/api/auth/login').set('X-Client-IP', `203.0.113.${50 + i}`).set('X-Proxy-Secret', 'guess').send({});
    }

    const res = await api().post('/api/auth/login').set('X-Client-IP', '203.0.113.99').send({});

    expectTooMany(res, 15 * 60);
  });
});
