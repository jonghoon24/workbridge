import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, authed } from './helpers/api';
import { makeClient } from './helpers/factories';

/**
 * Request ids and access logging — BEHAVIOR.md rule 9 (and rule 1's logging half, [C7]).
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  process.env.LOG_LEVEL = 'error';
  vi.restoreAllMocks();
});

/** JSON lines written through `console.log` / `console.error` while `fn` runs, at `level`. */
async function captureLogs<T>(level: string, fn: () => Promise<T>) {
  process.env.LOG_LEVEL = level;
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await fn();
    const parse = (calls: unknown[][]) => calls.map(([line]) => JSON.parse(String(line)));
    return { result, out: parse(out.mock.calls), err: parse(err.mock.calls) };
  } finally {
    process.env.LOG_LEVEL = 'error';
    out.mockRestore();
    err.mockRestore();
  }
}

describe('X-Request-Id', () => {
  it('is generated as a UUID v4 when absent', async () => {
    const res = await api().get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID_V4);
  });

  it('differs between requests', async () => {
    const a = await api().get('/health');
    const b = await api().get('/health');

    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it.each(['abc', 'req.2026-10-21_01', 'A'.repeat(128)])('echoes a well-formed incoming id %#', async (id) => {
    const res = await api().get('/health').set('X-Request-Id', id);

    expect(res.headers['x-request-id']).toBe(id);
  });

  it.each(['', 'has space', 'semi;colon', 'slash/inside', 'A'.repeat(129)])(
    'replaces a malformed incoming id %#',
    async (id) => {
      const res = await api().get('/health').set('X-Request-Id', id);

      expect(res.headers['x-request-id']).toMatch(UUID_V4);
    },
  );

  it('is on error responses, but never in the error body', async () => {
    const res = await api().get('/api/projects/missing-project-id').set('X-Request-Id', 'trace-404');

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('trace-404');
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
  });

  it('is on 401s, unmatched paths and body-parse failures', async () => {
    const unauthenticated = await api().get('/api/users/me');
    const unmatched = await api().get('/api/no-such-route');
    const malformed = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');

    expect(unauthenticated.status).toBe(401);
    expect(unmatched.status).toBe(404);
    expect(malformed.status).toBe(400);
    for (const res of [unauthenticated, unmatched, malformed]) {
      expect(res.headers['x-request-id']).toMatch(UUID_V4);
    }
  });
});

describe('access log', () => {
  it('writes one info line per request, without the query string', async () => {
    const { result: res, out, err } = await captureLogs('info', () =>
      api().get('/api/projects?search=secret&page=1').set('X-Request-Id', 'trace-list'));

    expect(res.status).toBe(200);
    expect(err).toEqual([]);
    const lines = out.filter((line) => line.msg === 'request');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      requestId: 'trace-list',
      method: 'GET',
      path: '/api/projects',
      status: 200,
      ip: expect.any(String),
    });
    expect(typeof lines[0].durationMs).toBe('number');
    expect(typeof lines[0].time).toBe('string');
    expect(lines[0]).not.toHaveProperty('userId');
  });

  it('includes the user id on authenticated requests', async () => {
    const client = await makeClient();

    const { out } = await captureLogs('info', () => authed(client).get('/api/users/me'));

    expect(out.find((line) => line.msg === 'request')).toMatchObject({ status: 200, userId: client.id });
  });

  it('logs a 4xx at info only [C7]', async () => {
    const { out, err } = await captureLogs('info', () => api().get('/api/projects/missing-project-id'));

    expect(err).toEqual([]);
    expect(out.find((line) => line.msg === 'request')).toMatchObject({ level: 'info', status: 404 });
  });

  it('a 500 is access-logged at info and error-logged exactly once by errorHandler [C7]', async () => {
    const client = await makeClient();

    // A non-string `milestoneId` makes Prisma reject the lookup — the suite's standing 500 vector.
    const { result: res, out, err } = await captureLogs('info', () =>
      authed(client).post('/api/payments').set('X-Request-Id', 'trace-500').send({ milestoneId: 12345 }));

    expect(res.status).toBe(500);
    expect(out.find((line) => line.msg === 'request')).toMatchObject({ level: 'info', status: 500, requestId: 'trace-500' });
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({
      level: 'error',
      msg: 'unhandled error',
      requestId: 'trace-500',
      method: 'POST',
      path: '/api/payments',
    });
    expect(err[0].err.message).toEqual(expect.any(String));
    expect(err[0].err.stack).toEqual(expect.any(String));
  });

  it('stays silent below the configured level', async () => {
    const { out, err } = await captureLogs('error', () => api().get('/health'));

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});
