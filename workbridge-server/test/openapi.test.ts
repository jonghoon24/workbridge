import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/openapi/document';
import { api, app, authed } from './helpers/api';
import {
  conformanceError,
  documentedOperations,
  findOperation,
  toOpenApiPath,
} from './helpers/openapi';
import { mountedRoutes } from './helpers/routes';

/**
 * The OpenAPI document (`src/openapi/`) against the code. Two guards keep it from drifting:
 *
 * 1. **Routes** — below: the routes the app mounts and the routes the document lists are the same
 *    set, compared both ways.
 * 2. **Responses** — everywhere: `api()` and `authed()` check every response of every test against
 *    the documented schema of its status (`test/helpers/openapi.ts`). The tests at the end of this
 *    file check the checker.
 */

/** Mounted but deliberately not in the document: the API reference itself (`docs.routes.ts`). */
const UNDOCUMENTED_ROUTES = ['GET /api/docs', 'GET /api/openapi.json'];

describe('route coverage', () => {
  const mounted = mountedRoutes(app)
    .map((route) => `${route.method} ${toOpenApiPath(route.path)}`)
    .filter((route) => !UNDOCUMENTED_ROUTES.includes(route));
  const documented = documentedOperations().map((op) => `${op.method.toUpperCase()} ${op.path}`);

  it('documents every route the app mounts', () => {
    expect(mounted.filter((route) => !documented.includes(route))).toEqual([]);
  });

  it('documents no route the app does not mount', () => {
    expect(documented.filter((route) => !mounted.includes(route))).toEqual([]);
  });

  it('lists each route once and reads a full router stack', () => {
    expect(new Set(documented).size).toBe(documented.length);
    expect(mounted.length).toBeGreaterThan(70);
    expect(mountedRoutes(app).map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(UNDOCUMENTED_ROUTES));
  });
});

describe('the document', () => {
  const document = buildOpenApiDocument();
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((method) => {
      const operation = item[method];
      return operation ? [{ label: `${method.toUpperCase()} ${path}`, path, operation }] : [];
    }));

  it('matches the committed openapi.json — run `npm run openapi` after changing a schema or route', () => {
    const committed = readFileSync(resolve(__dirname, '..', 'openapi.json'), 'utf8');

    expect(committed).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it('gives every operation a unique operationId, a tag, a summary and an explicit security', () => {
    const ids = operations.map(({ operation }) => operation.operationId);

    expect(new Set(ids).size).toBe(operations.length);
    for (const { label, operation } of operations) {
      expect(operation.operationId, label).toBeTruthy();
      expect(operation.tags?.length, label).toBeGreaterThan(0);
      expect(operation.summary, label).toBeTruthy();
      expect(operation.security, label).toBeDefined();
    }
  });

  it('declares every path parameter of every template', () => {
    for (const { label, path, operation } of operations) {
      const inTemplate = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const declared = (operation.parameters ?? [])
        .flatMap((parameter) => ('in' in parameter && parameter.in === 'path' ? [parameter.name] : []))
        .sort();

      expect(declared, label).toEqual(inTemplate);
    }
  });
});

describe('GET /api/openapi.json and GET /api/docs', () => {
  const vercelEnv = process.env.VERCEL_ENV;
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercelEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });

  it('serves the generated document', async () => {
    const res = await api().get('/api/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('serves the Scalar page pinned to an exact version with an integrity hash', async () => {
    const res = await api().get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/src="https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/[^"]+"/);
    expect(res.text).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(res.text).toContain("url: '/api/openapi.json'");
  });

  it.each(['/api/openapi.json', '/api/docs'])('%s is the same JSON 404 as an unmatched path in production', async (path) => {
    process.env.VERCEL_ENV = 'production';

    const res = await api().get(path);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Not found' } });
  });

  it.each(['/api/openapi.json', '/api/docs'])(
    '%s is the same JSON 404 as an unmatched path when VERCEL_ENV is unset and NODE_ENV is production',
    async (path) => {
      delete process.env.VERCEL_ENV;
      process.env.NODE_ENV = 'production';

      const res = await api().get(path);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Not found' } });
    },
  );

  it('is off on a deployment whose VERCEL_ENV is not a known non-production value', async () => {
    process.env.VERCEL_ENV = 'staging';

    expect((await api().get('/api/openapi.json')).status).toBe(404);
  });

  it.each(['preview', 'development'])('is served on a %s deployment', async (environment) => {
    process.env.VERCEL_ENV = environment;

    expect((await api().get('/api/openapi.json')).status).toBe(200);
  });

  it('is served on a preview deployment even though NODE_ENV is production', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'production';

    expect((await api().get('/api/openapi.json')).status).toBe(200);
  });

  it('is served locally when VERCEL_ENV is unset and NODE_ENV is not production', async () => {
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = 'test';

    expect((await api().get('/api/openapi.json')).status).toBe(200);
  });
});

/** A response as supertest hands it to an assertion, for checking the checker. */
function fakeResponse(method: string, path: string, status: number, body: unknown, contentType = 'application/json'): Response {
  return {
    request: { method, url: `http://127.0.0.1${path}` },
    status,
    headers: { 'content-type': `${contentType}; charset=utf-8` },
    body,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as Response;
}

describe('the response check', () => {
  it('passes a documented status with a matching body', () => {
    expect(conformanceError(fakeResponse('GET', '/health', 200, { status: 'ok' }))).toBeNull();
  });

  it('fails a key the schema does not list, at any depth', () => {
    expect(conformanceError(fakeResponse('GET', '/health', 200, { status: 'ok', uptime: 1 }))).toMatch(/uptime/);

    const error = conformanceError(fakeResponse('GET', '/api/notifications/unread-count', 401, {
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required', stack: '…' },
    }));
    expect(error).toMatch(/stack/);
  });

  it('fails a wrong type and a missing key', () => {
    expect(conformanceError(fakeResponse('GET', '/api/conversations/unread-count', 200, { unreadCount: '3' }))).toMatch(/unreadCount/);
    expect(conformanceError(fakeResponse('GET', '/api/conversations/unread-count', 200, {}))).toMatch(/unreadCount: Required/);
  });

  it('fails a status the route does not document', () => {
    expect(conformanceError(fakeResponse('GET', '/health', 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'x' } })))
      .toMatch(/status 404 is not documented for GET \/health/);
  });

  it('fails a content type the status does not document', () => {
    expect(conformanceError(fakeResponse('GET', '/health', 200, '<p>ok</p>', 'text/html'))).toMatch(/content type/);
  });

  it('checks a 500 only for being exactly the INTERNAL_ERROR envelope', () => {
    const internal = { error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } };
    expect(conformanceError(fakeResponse('GET', '/health', 500, internal))).toBeNull();
    expect(conformanceError(fakeResponse('GET', '/health', 500, { message: 'boom' }))).toMatch(/INTERNAL_ERROR envelope/);
    expect(conformanceError(fakeResponse('GET', '/health', 500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } })))
      .toMatch(/INTERNAL_ERROR envelope/);
    expect(conformanceError(fakeResponse('GET', '/health', 500, { error: { ...internal.error, detail: 'P2002' } })))
      .toMatch(/detail/);
  });

  it('fails an error code the route does not document for that status', () => {
    const path = '/api/notifications/unread-count';
    expect(conformanceError(fakeResponse('GET', path, 401, { error: { code: 'AUTH_REQUIRED', message: 'x' } }))).toBeNull();
    expect(conformanceError(fakeResponse('GET', path, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'x' } })))
      .toMatch(/code/);
  });

  it('allows fields only on a VALIDATION_FAILED, and requires them there', () => {
    const path = '/api/projects';
    const fields = [{ path: 'title', code: 'REQUIRED' }];
    expect(conformanceError(fakeResponse('POST', path, 400, { error: { code: 'VALIDATION_FAILED', message: 'title: x', fields } }))).toBeNull();
    expect(conformanceError(fakeResponse('POST', path, 400, { error: { code: 'VALIDATION_FAILED', message: 'title: x' } }))).not.toBeNull();
    expect(conformanceError(fakeResponse('POST', path, 400, { error: { code: 'MALFORMED_BODY', message: 'x', fields } }))).not.toBeNull();
  });

  it('documents the request-level causes on every route, so a malformed body conforms anywhere', () => {
    for (const op of documentedOperations()) {
      for (const [status, code] of [['400', 'MALFORMED_BODY'], ['413', 'PAYLOAD_TOO_LARGE'], ['415', 'UNSUPPORTED_MEDIA_TYPE']] as const) {
        const body = { error: { code, message: 'x' } };
        expect(conformanceError(fakeResponse(op.method.toUpperCase(), op.path.replace(/\{[^}]+\}/g, 'x'), Number(status), body)), `${op.method} ${op.path}`)
          .toBeNull();
      }
    }
  });

  it('skips a path no route documents — the 404 of an unknown path', () => {
    expect(conformanceError(fakeResponse('GET', '/api/nope', 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Not found' } }))).toBeNull();
  });

  it('matches the most literal route, as the routers do', () => {
    expect(findOperation('GET', '/api/users/me')?.path).toBe('/api/users/me');
    expect(findOperation('GET', '/api/users/u-1')?.path).toBe('/api/users/{id}');
    expect(findOperation('GET', '/api/settlements/summary')?.path).toBe('/api/settlements/summary');
    expect(findOperation('GET', '/api/users/me/portfolio')?.path).toBe('/api/users/{id}/portfolio');
  });

  it('is attached to every request made through the helpers', async () => {
    const unauthenticated = api().get('/health');
    const authenticated = authed({ id: 'u-1', email: 'u@test.local', role: 'CLIENT' }).post('/api/reviews');
    const nonConforming = fakeResponse('GET', '/health', 200, { status: 'ok', uptime: 1 });

    for (const test of [unauthenticated, authenticated]) {
      // supertest wraps each `.expect(fn)` assertion; the wrapper returns what the check throws.
      const asserts = (test as unknown as { _asserts: ((res: Response) => unknown)[] })._asserts;
      expect(asserts).toHaveLength(1);
      expect(String(asserts[0](nonConforming))).toMatch(/OpenAPI conformance: .*uptime/s);
    }
    await Promise.all([unauthenticated, authenticated]);
  });
});
