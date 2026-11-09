import type { Server } from 'node:http';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';

import app from '../../src/index';
import { generateAccessToken } from '../../src/lib/jwt';
import { conformsToOpenApi } from './openapi';

export { app };

/**
 * One listening server per test file, reused by every request in it.
 *
 * Passing `app` straight to supertest makes it create and tear down an ephemeral server *per
 * assertion*. Across this suite that is ~1,400 `listen(0)` calls, and under that port pressure a
 * reused socket can pair a response with the wrong request — which showed up as roughly one
 * spurious failure per 20 full-suite runs, landing on an arbitrary test and looking exactly like
 * a product regression. Vitest gives each test file its own module registry, so this module-level
 * server is per-file.
 *
 * It is `unref()`d rather than closed in an `afterAll`, because the hook would have to live in
 * `test/setup.ts` — and importing this module from there loads the app before any test file's
 * `vi.mock` can register, which breaks every mocked test in the suite. An unref'd handle does not
 * hold the event loop open, so the process still exits cleanly.
 */
let server: Server | undefined;

function listening(): Server {
  if (!server) {
    server = app.listen(0);
    server.unref();
  }
  return server;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';

/**
 * The request builders. Every request they make is checked against the OpenAPI document when its
 * response arrives (`./openapi.ts`): an undocumented status or a body that differs from the
 * documented schema fails the test that made it.
 */
function builders(headers: Record<string, string>) {
  const build = (method: Method) => (url: string) =>
    request(listening())[method](url).set(headers).expect(conformsToOpenApi);

  return {
    get: build('get'),
    post: build('post'),
    put: build('put'),
    patch: build('patch'),
    delete: build('delete'),
    /** CORS preflights; no route documents `OPTIONS`, so these are never checked. */
    options: build('options'),
  };
}

/** Unauthenticated request builder: `api().get('/api/projects')`. */
export const api = () => builders({});

export type Principal = Pick<User, 'id' | 'email' | 'role'>;

/**
 * Mints a token directly instead of calling `POST /api/auth/login`, so a test of some other
 * endpoint cannot fail because login is broken. Login has its own tests.
 */
export function tokenFor(user: Principal): string {
  return generateAccessToken({ id: user.id, email: user.email, role: user.role });
}

/** Authenticated request builder: `authed(client).post('/api/projects').send({ … })`. */
export function authed(user: Principal) {
  return builders({ Authorization: `Bearer ${tokenFor(user)}` });
}

/** A syntactically valid token signed with the wrong secret — must be rejected as 401. */
export function tokenWithWrongSecret(user: Principal): string {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, 'not_the_real_secret');
}

/** A token that is correctly signed but already expired — must be rejected as 401. */
export function expiredToken(user: Principal): string {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_ACCESS_SECRET as string,
    { expiresIn: '-1s' },
  );
}
