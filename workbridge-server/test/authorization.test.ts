import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every request goes through `api()` / `authed()` so it reuses this file's single shared server.
// This file drives ~270 requests from its route tables; calling `request(app)` directly would
// create an ephemeral `listen(0)` for each one, which is the port pressure that made the suite
// fail spuriously about once every 20 runs.
import {
  api,
  app,
  authed,
  expiredToken,
  tokenFor,
  tokenWithWrongSecret,
  type Principal,
} from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeCareer,
  makeClient,
  makeContract,
  makeConversation,
  makeFreelancer,
  makeMessage,
  makeMilestone,
  makePayment,
  makePortfolioItem,
  makeProject,
} from './helpers/factories';
import { generateRefreshToken } from '../src/lib/jwt';

/**
 * The cross-cutting authentication/authorization matrix.
 *
 * This file exists as the compensating control for a deliberate type-safety tradeoff: the
 * codebase augments `Express.Request.user` as **non-optional**, so the compiler cannot warn
 * when a public handler reads `req.user`, nor when a protected route loses its `authenticate`
 * middleware. Only a test that walks every route can catch that, so every assertion below is
 * driven off two route tables, PROTECTED_ROUTES and PUBLIC_ROUTES. `the route table itself`
 * compares them with the routes the Express app actually mounts, so a new route that is in
 * neither table fails the suite until it is added — and adding it adds coverage everywhere.
 */

// No test may reach a real external service. The route-level role and ownership checks all
// run before any provider call, so these mocks should never fire — they are here so that a
// regression which *does* let a request through fails loudly instead of opening a socket.
vi.mock('axios', () => ({
  default: {
    get: vi.fn(async () => {
      throw new Error('network disabled in tests');
    }),
    post: vi.fn(async () => {
      throw new Error('network disabled in tests');
    }),
  },
}));

vi.mock('../src/lib/openai', () => ({
  default: {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  features: [
                    {
                      name: '기능',
                      description: '설명',
                      estimatedCost: 1_000_000,
                      rationale: '근거',
                      duration: '1주',
                    },
                  ],
                  totalAmount: 1_000_000,
                  summary: '요약',
                  marketReference: '참고',
                }),
              },
            },
          ],
        })),
      },
    },
  },
}));

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Path/body parameters a route needs, so the table can be reused with real or missing ids. */
interface Ids {
  userId: string;
  projectId: string;
  applicationId: string;
  contractId: string;
  notificationId: string;
  orderId: string;
  milestoneId: string;
  settlementId: string;
  portfolioItemId: string;
  careerId: string;
  conversationId: string;
  messageId: string;
}

interface RouteSpec {
  /** `METHOD /path` — also the `it.each` test name via `$label`. */
  label: string;
  method: HttpMethod;
  path: (ids: Ids) => string;
  body?: (ids: Ids) => Record<string, unknown>;
  /** Role the route is gated on, `null` when any authenticated user may call it. */
  role: 'CLIENT' | 'FREELANCER' | null;
  /** Where the role check lives: `requireRole` middleware, or inside the controller. */
  gate: 'middleware' | 'controller' | null;
}

/** Ids that match nothing, for tests that must be rejected before any lookup happens. */
const MISSING: Ids = {
  userId: 'missing-user-id',
  projectId: 'missing-project-id',
  applicationId: 'missing-application-id',
  contractId: 'missing-contract-id',
  notificationId: 'missing-notification-id',
  orderId: 'missing-order-id',
  milestoneId: 'missing-milestone-id',
  settlementId: 'missing-settlement-id',
  portfolioItemId: 'missing-portfolio-item-id',
  careerId: 'missing-career-id',
  conversationId: 'missing-conversation-id',
  messageId: 'missing-message-id',
};

/** Verification fails before any database read, so these tests need no fixture user. */
const GHOST: Principal = { id: 'ghost-user-id', email: 'ghost@test.local', role: 'CLIENT' };

/**
 * Every route that mounts `authenticate`, grouped by the file in `src/routes/` that declares it.
 * The label is `METHOD /mounted/path` with the router's own parameter names — `the route table
 * itself` matches it against the app's router stack.
 */
const PROTECTED_ROUTES: RouteSpec[] = [
  // auth.routes.ts
  { label: 'POST /api/auth/logout', method: 'post', path: () => '/api/auth/logout', role: null, gate: null },
  {
    label: 'POST /api/auth/select-role',
    method: 'post',
    path: () => '/api/auth/select-role',
    body: () => ({ role: 'CLIENT' }),
    role: null,
    gate: null,
  },

  // users.routes.ts
  { label: 'GET /api/users/me', method: 'get', path: () => '/api/users/me', role: null, gate: null },
  {
    label: 'PATCH /api/users/me',
    method: 'patch',
    path: () => '/api/users/me',
    body: () => ({ name: 'New Name' }),
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/users/me/applications',
    method: 'get',
    path: () => '/api/users/me/applications',
    role: 'FREELANCER',
    gate: 'controller',
  },
  {
    label: 'GET /api/users/me/bookmarks',
    method: 'get',
    path: () => '/api/users/me/bookmarks',
    role: 'FREELANCER',
    gate: 'controller',
  },
  {
    label: 'GET /api/users/me/projects',
    method: 'get',
    path: () => '/api/users/me/projects',
    role: 'CLIENT',
    gate: 'controller',
  },
  {
    label: 'GET /api/users/me/payout-account',
    method: 'get',
    path: () => '/api/users/me/payout-account',
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'PUT /api/users/me/payout-account',
    method: 'put',
    path: () => '/api/users/me/payout-account',
    body: () => ({ bankCode: '004', accountNumber: '110-1234-56789', holderName: 'Nobody' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'DELETE /api/users/me/payout-account',
    method: 'delete',
    path: () => '/api/users/me/payout-account',
    role: 'FREELANCER',
    gate: 'middleware',
  },

  // profile.routes.ts (the two public GETs are in PUBLIC_ROUTES)
  {
    label: 'POST /api/users/me/portfolio',
    method: 'post',
    path: () => '/api/users/me/portfolio',
    body: () => ({ title: 'A portfolio item' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'PUT /api/users/me/portfolio/order',
    method: 'put',
    path: () => '/api/users/me/portfolio/order',
    body: () => ({ ids: [] }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'PATCH /api/users/me/portfolio/:itemId',
    method: 'patch',
    path: (ids) => `/api/users/me/portfolio/${ids.portfolioItemId}`,
    body: () => ({ title: 'Renamed' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'DELETE /api/users/me/portfolio/:itemId',
    method: 'delete',
    path: (ids) => `/api/users/me/portfolio/${ids.portfolioItemId}`,
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'POST /api/users/me/careers',
    method: 'post',
    path: () => '/api/users/me/careers',
    body: () => ({ company: 'Codeit', position: 'Developer', employmentType: 'FULL_TIME', startDate: '2021-03' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'PATCH /api/users/me/careers/:careerId',
    method: 'patch',
    path: (ids) => `/api/users/me/careers/${ids.careerId}`,
    body: () => ({ position: 'Lead' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'DELETE /api/users/me/careers/:careerId',
    method: 'delete',
    path: (ids) => `/api/users/me/careers/${ids.careerId}`,
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'GET /api/users/me/profile-completion',
    method: 'get',
    path: () => '/api/users/me/profile-completion',
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/users/me/recommended-projects',
    method: 'get',
    path: () => '/api/users/me/recommended-projects',
    role: 'FREELANCER',
    gate: 'middleware',
  },

  // projects.routes.ts
  {
    label: 'GET /api/projects/:id/recommended-freelancers',
    method: 'get',
    path: (ids) => `/api/projects/${ids.projectId}/recommended-freelancers`,
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'POST /api/projects',
    method: 'post',
    path: () => '/api/projects',
    body: () => ({
      title: 'A new project',
      description: 'Something worth building',
      category: '웹 개발',
      budget: 3_000_000,
      deadline: daysFromNow(20).toISOString(),
    }),
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'GET /api/projects/:id/bookmark',
    method: 'get',
    path: (ids) => `/api/projects/${ids.projectId}/bookmark`,
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'POST /api/projects/:id/bookmark',
    method: 'post',
    path: (ids) => `/api/projects/${ids.projectId}/bookmark`,
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'DELETE /api/projects/:id/bookmark',
    method: 'delete',
    path: (ids) => `/api/projects/${ids.projectId}/bookmark`,
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'PATCH /api/projects/:id',
    method: 'patch',
    path: (ids) => `/api/projects/${ids.projectId}`,
    body: () => ({ title: 'Edited title' }),
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'DELETE /api/projects/:id',
    method: 'delete',
    path: (ids) => `/api/projects/${ids.projectId}`,
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'PATCH /api/projects/:id/status',
    method: 'patch',
    path: (ids) => `/api/projects/${ids.projectId}/status`,
    body: () => ({ status: 'CLOSED' }),
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'POST /api/projects/:id/analyze',
    method: 'post',
    path: (ids) => `/api/projects/${ids.projectId}/analyze`,
    role: 'CLIENT',
    gate: 'middleware',
  },

  // applications.routes.ts (also mounted under /api/projects)
  {
    label: 'POST /api/projects/:id/applications',
    method: 'post',
    path: (ids) => `/api/projects/${ids.projectId}/applications`,
    body: () => ({ coverLetter: 'Pick me', expectedRate: 3_000_000, expectedDuration: '3주' }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'GET /api/projects/:id/applications',
    method: 'get',
    path: (ids) => `/api/projects/${ids.projectId}/applications`,
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'PATCH /api/projects/:projectId/applications/:appId',
    method: 'patch',
    path: (ids) => `/api/projects/${ids.projectId}/applications/${ids.applicationId}`,
    body: () => ({ status: 'REJECTED' }),
    role: 'CLIENT',
    gate: 'middleware',
  },

  // contracts.routes.ts
  { label: 'GET /api/contracts', method: 'get', path: () => '/api/contracts', role: null, gate: null },
  {
    label: 'GET /api/contracts/:id/milestones',
    method: 'get',
    path: (ids) => `/api/contracts/${ids.contractId}/milestones`,
    role: null,
    gate: null,
  },
  {
    label: 'PUT /api/contracts/:id/milestones',
    method: 'put',
    path: (ids) => `/api/contracts/${ids.contractId}/milestones`,
    body: () => ({ milestones: [{ title: 'All', amount: 4_000_000, dueDate: '2099-01-01' }] }),
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'GET /api/contracts/:id',
    method: 'get',
    path: (ids) => `/api/contracts/${ids.contractId}`,
    role: null,
    gate: null,
  },
  {
    label: 'PATCH /api/contracts/:id',
    method: 'patch',
    path: (ids) => `/api/contracts/${ids.contractId}`,
    body: () => ({ status: 'COMPLETED' }),
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/contracts/:id/sign',
    method: 'post',
    path: (ids) => `/api/contracts/${ids.contractId}/sign`,
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/contracts/:id/conversation',
    method: 'get',
    path: (ids) => `/api/contracts/${ids.contractId}/conversation`,
    role: null,
    gate: null,
  },

  // payments.routes.ts
  {
    label: 'POST /api/payments',
    method: 'post',
    path: () => '/api/payments',
    body: (ids) => ({ milestoneId: ids.milestoneId }),
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/payments/confirm',
    method: 'post',
    path: () => '/api/payments/confirm',
    body: (ids) => ({ paymentKey: 'test_payment_key', orderId: ids.orderId, amount: 4_000_000 }),
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/payments/dev-complete',
    method: 'post',
    path: () => '/api/payments/dev-complete',
    body: (ids) => ({ milestoneId: ids.milestoneId }),
    role: null,
    gate: null,
  },
  { label: 'GET /api/payments', method: 'get', path: () => '/api/payments', role: null, gate: null },

  // milestones.routes.ts
  {
    label: 'GET /api/milestones/:id',
    method: 'get',
    path: (ids) => `/api/milestones/${ids.milestoneId}`,
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/milestones/:id/attachments/:attachmentId/download',
    method: 'get',
    path: (ids) => `/api/milestones/${ids.milestoneId}/attachments/missing-attachment-id/download`,
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/milestones/:id/uploads',
    method: 'post',
    path: (ids) => `/api/milestones/${ids.milestoneId}/uploads`,
    body: () => ({ files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 10 }] }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'POST /api/milestones/:id/submissions',
    method: 'post',
    path: (ids) => `/api/milestones/${ids.milestoneId}/submissions`,
    body: () => ({ message: 'Done', links: [] }),
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'POST /api/milestones/:id/approve',
    method: 'post',
    path: (ids) => `/api/milestones/${ids.milestoneId}/approve`,
    role: 'CLIENT',
    gate: 'middleware',
  },
  {
    label: 'POST /api/milestones/:id/reject',
    method: 'post',
    path: (ids) => `/api/milestones/${ids.milestoneId}/reject`,
    body: () => ({ reason: 'Please fix the layout.' }),
    role: 'CLIENT',
    gate: 'middleware',
  },

  // settlements.routes.ts
  {
    label: 'GET /api/settlements',
    method: 'get',
    path: () => '/api/settlements',
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'GET /api/settlements/summary',
    method: 'get',
    path: () => '/api/settlements/summary',
    role: 'FREELANCER',
    gate: 'middleware',
  },
  {
    label: 'GET /api/settlements/:id',
    method: 'get',
    path: (ids) => `/api/settlements/${ids.settlementId}`,
    role: 'FREELANCER',
    gate: 'middleware',
  },

  // reviews.routes.ts
  {
    label: 'POST /api/reviews',
    method: 'post',
    path: () => '/api/reviews',
    body: (ids) => ({
      contractId: ids.contractId,
      revieweeId: ids.userId,
      rating: 5,
      content: 'Great work',
    }),
    role: null,
    gate: null,
  },

  // notifications.routes.ts
  { label: 'GET /api/notifications', method: 'get', path: () => '/api/notifications', role: null, gate: null },
  {
    label: 'GET /api/notifications/unread-count',
    method: 'get',
    path: () => '/api/notifications/unread-count',
    role: null,
    gate: null,
  },
  {
    label: 'PATCH /api/notifications/read-all',
    method: 'patch',
    path: () => '/api/notifications/read-all',
    role: null,
    gate: null,
  },
  {
    label: 'PATCH /api/notifications/:id/read',
    method: 'patch',
    path: (ids) => `/api/notifications/${ids.notificationId}/read`,
    role: null,
    gate: null,
  },
  // notifications.routes.ts — notification preferences
  {
    label: 'GET /api/notifications/preferences',
    method: 'get',
    path: () => '/api/notifications/preferences',
    role: null,
    gate: null,
  },
  {
    label: 'PUT /api/notifications/preferences',
    method: 'put',
    path: () => '/api/notifications/preferences',
    body: () => ({ preferences: [{ type: 'MILESTONE_DUE_SOON', email: false }] }),
    role: null,
    gate: null,
  },

  // conversations.routes.ts
  { label: 'GET /api/conversations', method: 'get', path: () => '/api/conversations', role: null, gate: null },
  {
    label: 'GET /api/conversations/unread-count',
    method: 'get',
    path: () => '/api/conversations/unread-count',
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/conversations/:id',
    method: 'get',
    path: (ids) => `/api/conversations/${ids.conversationId}`,
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/conversations/:id/messages',
    method: 'get',
    path: (ids) => `/api/conversations/${ids.conversationId}/messages`,
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/conversations/:id/uploads',
    method: 'post',
    path: (ids) => `/api/conversations/${ids.conversationId}/uploads`,
    body: () => ({ files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 10 }] }),
    role: null,
    gate: null,
  },
  {
    label: 'GET /api/conversations/:id/attachments/:attachmentId/download',
    method: 'get',
    path: (ids) => `/api/conversations/${ids.conversationId}/attachments/missing-attachment-id/download`,
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/conversations/:id/messages',
    method: 'post',
    path: (ids) => `/api/conversations/${ids.conversationId}/messages`,
    body: () => ({ body: 'Hello' }),
    role: null,
    gate: null,
  },
  {
    label: 'POST /api/conversations/:id/read',
    method: 'post',
    path: (ids) => `/api/conversations/${ids.conversationId}/read`,
    role: null,
    gate: null,
  },
  {
    label: 'DELETE /api/conversations/:id/messages/:messageId',
    method: 'delete',
    path: (ids) => `/api/conversations/${ids.conversationId}/messages/${ids.messageId}`,
    role: null,
    gate: null,
  },
];

interface PublicSpec {
  label: string;
  method: HttpMethod;
  path: () => string;
  body?: () => Record<string, unknown>;
  cookies?: () => string[];
  /** Deterministic status given the `pub` fixtures. */
  expected: number;
}

/** Fixtures for PUBLIC_ROUTES, rebuilt before each test in `the public surface`. */
let pub: { user: { id: string }; projectId: string; refreshCookie: string };

/** Every route reachable without a JWT. */
const PUBLIC_ROUTES: PublicSpec[] = [
  // Missing fields, so 400 — the point is that it is the validator answering, not `authenticate`.
  { label: 'POST /api/auth/signup', method: 'post', path: () => '/api/auth/signup', expected: 400 },
  { label: 'POST /api/auth/login', method: 'post', path: () => '/api/auth/login', expected: 400 },
  {
    label: 'POST /api/auth/refresh',
    method: 'post',
    path: () => '/api/auth/refresh',
    cookies: () => [pub.refreshCookie],
    expected: 200,
  },
  { label: 'GET /api/auth/google', method: 'get', path: () => '/api/auth/google', expected: 302 },
  {
    label: 'GET /api/auth/google/callback',
    method: 'get',
    path: () => '/api/auth/google/callback',
    expected: 302,
  },
  { label: 'GET /api/projects', method: 'get', path: () => '/api/projects', expected: 200 },
  {
    label: 'GET /api/projects/:id',
    method: 'get',
    path: () => `/api/projects/${pub.projectId}`,
    expected: 200,
  },
  { label: 'GET /api/users/:id', method: 'get', path: () => `/api/users/${pub.user.id}`, expected: 200 },
  {
    label: 'GET /api/users/:id/reviews',
    method: 'get',
    path: () => `/api/users/${pub.user.id}/reviews`,
    expected: 200,
  },
  {
    label: 'GET /api/reviews/users/:id',
    method: 'get',
    path: () => `/api/reviews/users/${pub.user.id}`,
    expected: 200,
  },
  // profile.routes.ts — public portfolio and career lists. The fixture user is a CLIENT, so both lists are empty.
  {
    label: 'GET /api/users/:id/portfolio',
    method: 'get',
    path: () => `/api/users/${pub.user.id}/portfolio`,
    expected: 200,
  },
  {
    label: 'GET /api/users/:id/careers',
    method: 'get',
    path: () => `/api/users/${pub.user.id}/careers`,
    expected: 200,
  },
  // internal.routes.ts — guarded by `X-Internal-Token`, not a JWT. `INTERNAL_JOB_TOKEN` is
  // unset under test, so the endpoint does not exist (404); `jobs.test.ts` covers the rest.
  {
    label: 'POST /api/internal/jobs/run',
    method: 'post',
    path: () => '/api/internal/jobs/run',
    expected: 404,
  },
];

const ROLE_GATED_ROUTES = PROTECTED_ROUTES.filter((route) => route.role !== null);

/**
 * Outside both tables: the load balancer's liveness probe (mounted outside `src/routes/`) and the
 * API reference (`docs.routes.ts`, public, off in production — `test/openapi.test.ts`).
 */
const UNTABLED_ROUTES = ['GET /health', 'GET /api/openapi.json', 'GET /api/docs'];

interface RouterLayer {
  name: string;
  regexp: RegExp & { fast_slash?: boolean };
  keys: unknown[];
  route?: { path: unknown; methods: Record<string, boolean> };
  handle: { stack?: RouterLayer[] };
}

/** The literal prefix a `app.use(path, router)` layer matches (Express 4 compiles it to a regexp). */
function mountPathOf(layer: RouterLayer): string {
  if (layer.regexp.fast_slash) return '';
  const path = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
  if (layer.keys.length > 0 || /[\\^$()[\]{}*+?|]/.test(path)) {
    throw new Error(`cannot read a literal mount path from ${layer.regexp}`);
  }
  return path;
}

/** Every `METHOD /path` the app serves, read from its router stack (nested routers included). */
function mountedRoutes(): string[] {
  const routes: string[] = [];
  const walk = (stack: RouterLayer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        if (typeof path !== 'string') throw new Error(`non-string route path under ${prefix}`);
        for (const method of Object.keys(methods)) {
          routes.push(`${method.toUpperCase()} ${prefix}${path === '/' && prefix ? '' : path}`);
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPathOf(layer));
      }
    }
  };
  walk((app as unknown as { _router: { stack: RouterLayer[] } })._router.stack, '');
  return routes;
}

type ApiResponse = { status: number; body: any; headers?: Record<string, string> };

/** Issues `route` with an arbitrary set of headers. */
function call(route: RouteSpec, ids: Ids, headers: Record<string, string> = {}) {
  let req = api()[route.method](route.path(ids));
  for (const [name, value] of Object.entries(headers)) {
    req = req.set(name, value);
  }
  return route.body ? req.send(route.body(ids)) : req.send();
}

/**
 * Every error body is exactly `{ error: { message: string } }` — *exactly*, so
 * this asserts the whole shape rather than probing for the message. No `stack`, no `statusCode`,
 * no `success: false` alongside it, nothing nested under `error` but the one non-empty string,
 * and the response is JSON rather than Express's default HTML error page.
 */
function expectErrorEnvelope(res: ApiResponse, status: number) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: { message: expect.any(String) } });
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(Object.keys(res.body.error)).toEqual(['message']);
  expect(res.body.error.message.length).toBeGreaterThan(0);
  if (res.headers) {
    expect(res.headers['content-type']).toMatch(/application\/json/);
  }
}

describe('the route table itself', () => {
  it('lists every route the app mounts — each in exactly one table, none twice', () => {
    const tabled = [...PROTECTED_ROUTES, ...PUBLIC_ROUTES].map((r) => r.label).concat(UNTABLED_ROUTES);

    // Compared as sorted lists, not sets: a label in both tables, or a route mounted twice, fails.
    expect(mountedRoutes().sort()).toEqual(tabled.sort());
  });

  it('reads the mounted routes from the app rather than an empty or partial stack', () => {
    const mounted = mountedRoutes();

    expect(mounted).toContain('DELETE /api/conversations/:id/messages/:messageId');
    expect(mounted).toContain('GET /api/contracts');
    expect(mounted.length).toBeGreaterThan(70);
  });

  it('records a role gate for exactly the 34 role-gated routes', () => {
    expect(ROLE_GATED_ROUTES).toHaveLength(34);
    expect(ROLE_GATED_ROUTES.every((r) => r.gate !== null)).toBe(true);
    expect(PROTECTED_ROUTES.filter((r) => r.role === null).every((r) => r.gate === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

describe('authentication — no Authorization header', () => {
  it.each(PROTECTED_ROUTES)('$label → 401 Authentication required', async (route) => {
    const res = await call(route, MISSING);

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Authentication required');
  });
});

const MALFORMED_HEADERS = [
  // `'Bearer'` does not start with `'Bearer '`, so it never reaches token verification.
  { variant: 'Bearer with no token', header: 'Bearer', message: 'Authentication required' },
  { variant: 'a non-Bearer scheme', header: 'Token abc.def.ghi', message: 'Authentication required' },
  { variant: 'a bare token with no scheme', header: tokenFor(GHOST), message: 'Authentication required' },
  { variant: 'Bearer with a garbage token', header: 'Bearer not-a-jwt', message: 'Invalid or expired token' },
];

describe('authentication — malformed Authorization header', () => {
  const cases = PROTECTED_ROUTES.flatMap((route) =>
    MALFORMED_HEADERS.map((h) => ({ label: route.label, route, ...h })));

  it.each(cases)('$label → 401 given $variant', async ({ route, header, message }) => {
    const res = await call(route, MISSING, { Authorization: header });

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe(message);
  });

  it('the scheme is case-sensitive: `bearer <valid token>` is still 401', async () => {
    const client = await makeClient();

    const res = await api().get('/api/users/me').set('Authorization', `bearer ${tokenFor(client)}`);

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Authentication required');
  });

  it('authenticate runs before the multipart parser on PATCH /api/users/me', async () => {
    // If the order were reversed, an unauthenticated request could push a file through multer
    // (and, on the upload path, at Supabase) before being rejected.
    const res = await api()
      .patch('/api/users/me')
      .field('name', 'Uploader')
      .attach('profileImage', Buffer.from('not-really-a-png'), {
        filename: 'avatar.png',
        contentType: 'image/png',
      });

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Authentication required');
  });
});

describe('authentication — unverifiable tokens', () => {
  const TOKEN_KINDS = [
    { variant: 'a token signed with the wrong secret', token: tokenWithWrongSecret(GHOST) },
    { variant: 'an expired token', token: expiredToken(GHOST) },
  ];

  const cases = PROTECTED_ROUTES.flatMap((route) =>
    TOKEN_KINDS.map((k) => ({ label: route.label, route, ...k })));

  it.each(cases)('$label → 401 given $variant', async ({ route, token }) => {
    const res = await call(route, MISSING, { Authorization: `Bearer ${token}` });

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('rejects an expired token even one second past expiry, not just long-expired ones', async () => {
    const client = await makeClient();
    const res = await api()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${expiredToken(client)}`);

    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('accepts a correctly signed, unexpired token for the same principal', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/users/me');

    expect(res.status).toBe(200);
  });
});

describe('authentication — token claims', () => {
  /** Decodes without verifying: this is about the claim set, not the signature. */
  const claims = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

  it('the access token payload is exactly { id, email, role } plus iat/exp', async () => {
    const res = await api().post('/api/auth/signup').send({
      email: 'claims@test.local',
      password: 'password123',
      name: 'Claims',
      role: 'CLIENT',
    });

    expect(res.status).toBe(201);
    const payload = claims(res.body.accessToken);
    expect(Object.keys(payload).sort()).toEqual(['email', 'exp', 'iat', 'id', 'role']);
    expect(payload.email).toBe('claims@test.local');
    expect(payload.role).toBe('CLIENT');
    expect(payload.id).toBe(res.body.user.id);
  });

  it('the refresh token carries the same shape as the access token', async () => {
    const res = await api().post('/api/auth/signup').send({
      email: 'claims2@test.local',
      password: 'password123',
      name: 'Claims',
      role: 'FREELANCER',
    });

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refreshToken='));
    expect(cookie).toBeDefined();
    const refresh = cookie!.split(';')[0].slice('refreshToken='.length);

    expect(Object.keys(claims(refresh)).sort())
      .toEqual(Object.keys(claims(res.body.accessToken)).sort());
  });

  it('the access token lives 15 minutes', async () => {
    const client = await makeClient();
    const { iat, exp } = claims(tokenFor(client));

    expect(exp - iat).toBe(15 * 60);
  });

  it('role gating reads the role from the token, not from the database row', async () => {
    // A CLIENT row holding a token minted with a FREELANCER claim reaches FREELANCER-only
    // routes: `requireRole` compares against `req.user.role`, which comes from the claim, and
    // never re-reads the row. Consequence — a user demoted from FREELANCER to CLIENT keeps
    // FREELANCER access until the token expires (up to 15 minutes), because nothing revokes
    // the outstanding token. That follows from the stateless-token decision, but it is
    // privilege retention after demotion, which is still an open product question.
    // Pinned as current behavior rather than asserted as correct: if the answer becomes "look the
    // role up per request", this test is the one that must change.
    const client = await makeClient();
    const forgedRole = tokenFor({ id: client.id, email: client.email, role: 'FREELANCER' });

    const res = await api()
      .get('/api/users/me/bookmarks')
      .set('Authorization', `Bearer ${forgedRole}`);

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Authorization — role gating
// ---------------------------------------------------------------------------------------------

describe('authorization — role gating', () => {
  let ids: Ids;
  let client: Awaited<ReturnType<typeof makeClient>>;
  let freelancer: Awaited<ReturnType<typeof makeFreelancer>>;

  beforeEach(async () => {
    client = await makeClient();
    freelancer = await makeFreelancer();
    // A second freelancer owns the pre-existing application, so `freelancer` can still apply.
    const applicant = await makeFreelancer();
    const project = await makeProject(client.id, { status: 'OPEN' });
    const application = await makeApplication(project.id, applicant.id);

    ids = {
      ...MISSING,
      userId: freelancer.id,
      projectId: project.id,
      applicationId: application.id,
    };
  });

  const clientOnly = ROLE_GATED_ROUTES.filter((r) => r.role === 'CLIENT');
  const freelancerOnly = ROLE_GATED_ROUTES.filter((r) => r.role === 'FREELANCER');

  it('splits the role-gated routes into 12 CLIENT-only and 22 FREELANCER-only', () => {
    expect(clientOnly).toHaveLength(12);
    expect(freelancerOnly).toHaveLength(22);
  });

  it.each(clientOnly)('$label → 403 for a FREELANCER', async (route) => {
    const res = await call(route, ids, { Authorization: `Bearer ${tokenFor(freelancer)}` });

    expectErrorEnvelope(res, 403);
    if (route.gate === 'middleware') {
      expect(res.body.error.message).toBe('Insufficient permissions');
    }
  });

  it.each(freelancerOnly)('$label → 403 for a CLIENT', async (route) => {
    const res = await call(route, ids, { Authorization: `Bearer ${tokenFor(client)}` });

    expectErrorEnvelope(res, 403);
    if (route.gate === 'middleware') {
      expect(res.body.error.message).toBe('Insufficient permissions');
    }
  });

  // Without this the 403s above could be coming from something other than the role gate.
  it.each(ROLE_GATED_ROUTES)('$label does not 403 for the role it is gated on', async (route) => {
    const actor = route.role === 'CLIENT' ? client : freelancer;

    const res = await call(route, ids, { Authorization: `Bearer ${tokenFor(actor)}` });

    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });

  it('checks the role before profile completeness', async () => {
    // An incomplete FREELANCER hitting a CLIENT-only route must be told about the role, not
    // the profile — otherwise the ordering of the two 403s is unobservable.
    const incomplete = await makeUserWithIncompleteProfile();

    const res = await api()
      .post('/api/projects')
      .set('Authorization', `Bearer ${tokenFor(incomplete)}`)
      .send({ title: 't', description: 'd', category: '웹 개발', budget: 1, deadline: daysFromNow(5) });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Insufficient permissions');
  });

  it('role gating uses the token claim, so it cannot be overridden from the body', async () => {
    const res = await api()
      .post('/api/projects')
      .set('Authorization', `Bearer ${tokenFor(freelancer)}`)
      .send({ role: 'CLIENT', clientId: client.id, title: 't' });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Insufficient permissions');
    expect(await prisma.project.count({ where: { title: 't' } })).toBe(0);
  });

  /** A FREELANCER with every freelancer-specific field blank. */
  function makeUserWithIncompleteProfile() {
    return makeFreelancer({ skills: [], activityCategory: null, experienceYears: null, hourlyRate: null });
  }
});

// ---------------------------------------------------------------------------------------------
// Profile completeness — the whole field matrix, at the HTTP boundary
// ---------------------------------------------------------------------------------------------

/**
 * `lib.test.ts` covers `isProfileComplete` exhaustively as a pure function. That proves nothing
 * about the middleware around it: `requireCompleteProfile` re-reads the caller through its own
 * `profileSelect`, and a field missing from that projection arrives as `undefined`. Every
 * negative case would still 403 — for the wrong reason — so each role's matrix is paired with a
 * **positive control**: a fully complete profile of that role must get through. Drop `hourlyRate`
 * from `profileSelect` and the control is what catches it.
 *
 * Only two routes mount the middleware — `POST /api/projects` (CLIENT) and
 * `POST /api/projects/:id/applications` (FREELANCER) — and both sit behind `requireRole`, so
 * each role is exercised on the route it can actually reach.
 */
describe('authorization — profile completeness', () => {
  const INCOMPLETE = '프로필을 먼저 완성해주세요';
  type UserOverrides = NonNullable<Parameters<typeof makeClient>[0]>;

  /** An OPEN project owned by someone else, for the FREELANCER half of the matrix. */
  let projectId: string;

  beforeEach(async () => {
    const owner = await makeClient();
    projectId = (await makeProject(owner.id, { status: 'OPEN' })).id;
  });

  /** Complete enough that only the profile can be the reason for a rejection. */
  const validProject = () => ({
    title: 'Needs a complete profile',
    description: 'Something worth building',
    category: '웹 개발',
    budget: 3_000_000,
    deadline: daysFromNow(20).toISOString(),
  });

  const validApplication = () => ({
    coverLetter: 'Pick me',
    expectedRate: 3_000_000,
    expectedDuration: '3주',
  });

  const CLIENT_CASES: { field: string; overrides: UserOverrides }[] = [
    { field: 'companyName: null', overrides: { companyName: null } },
    { field: 'companyName: whitespace only', overrides: { companyName: '   ' } },
    { field: 'businessField: null', overrides: { businessField: null } },
    { field: 'businessField: whitespace only', overrides: { businessField: '\t \n' } },
  ];

  it.each(CLIENT_CASES)('POST /api/projects → 403 for a CLIENT with $field', async ({ overrides }) => {
    const client = await makeClient(overrides);

    const res = await api()
      .post('/api/projects')
      .set('Authorization', `Bearer ${tokenFor(client)}`)
      .send(validProject());

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe(INCOMPLETE);
    expect(await prisma.project.count({ where: { clientId: client.id } })).toBe(0);
  });

  it('POST /api/projects → 201 for a CLIENT complete in every field (positive control)', async () => {
    // If `profileSelect` ever stops projecting `role`, `companyName` or `businessField`, this is
    // the assertion that fails — the negative cases above would keep passing regardless.
    const client = await makeClient();

    const res = await api()
      .post('/api/projects')
      .set('Authorization', `Bearer ${tokenFor(client)}`)
      .send(validProject());

    expect(res.status).toBe(201);
    expect(await prisma.project.count({ where: { clientId: client.id } })).toBe(1);
  });

  const FREELANCER_CASES: { field: string; overrides: UserOverrides }[] = [
    { field: 'skills: []', overrides: { skills: [] } },
    { field: 'activityCategory: null', overrides: { activityCategory: null } },
    { field: 'activityCategory: whitespace only', overrides: { activityCategory: '  ' } },
    { field: 'experienceYears: null', overrides: { experienceYears: null } },
    { field: 'experienceYears: -1', overrides: { experienceYears: -1 } },
    { field: 'hourlyRate: null', overrides: { hourlyRate: null } },
    { field: 'hourlyRate: 0', overrides: { hourlyRate: 0 } },
  ];

  it.each(FREELANCER_CASES)(
    'POST /api/projects/:id/applications → 403 for a FREELANCER with $field',
    async ({ overrides }) => {
      const freelancer = await makeFreelancer(overrides);

      const res = await api()
        .post(`/api/projects/${projectId}/applications`)
        .set('Authorization', `Bearer ${tokenFor(freelancer)}`)
        .send(validApplication());

      expectErrorEnvelope(res, 403);
      expect(res.body.error.message).toBe(INCOMPLETE);
      expect(await prisma.application.count({ where: { freelancerId: freelancer.id } })).toBe(0);
    },
  );

  it('POST /api/projects/:id/applications → 201 for a complete FREELANCER (positive control)', async () => {
    const freelancer = await makeFreelancer();

    const res = await api()
      .post(`/api/projects/${projectId}/applications`)
      .set('Authorization', `Bearer ${tokenFor(freelancer)}`)
      .send(validApplication());

    expect(res.status).toBe(201);
    expect(await prisma.application.count({ where: { freelancerId: freelancer.id } })).toBe(1);
  });

  it('experienceYears: 0 is complete — the boundary a falsy check would reject', async () => {
    const freelancer = await makeFreelancer({ experienceYears: 0 });

    const res = await api()
      .post(`/api/projects/${projectId}/applications`)
      .set('Authorization', `Bearer ${tokenFor(freelancer)}`)
      .send(validApplication());

    expect(res.status).toBe(201);
  });

  it('the gate is a 403 about the profile, and nothing is created anywhere', async () => {
    // Ordering check: `requireCompleteProfile` runs before the controller, so an incomplete
    // profile is reported even when the body would also fail validation — and no partial write
    // happens on either path.
    const freelancer = await makeFreelancer({ hourlyRate: null });

    const res = await api()
      .post(`/api/projects/${projectId}/applications`)
      .set('Authorization', `Bearer ${tokenFor(freelancer)}`)
      .send({});

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe(INCOMPLETE);
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The public surface — these routes must stay reachable without a token
// ---------------------------------------------------------------------------------------------

describe('the public surface', () => {
  beforeEach(async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { status: 'OPEN' });
    pub = {
      user: client,
      projectId: project.id,
      refreshCookie: `refreshToken=${generateRefreshToken({
        id: client.id,
        email: client.email,
        role: client.role,
      })}`,
    };
  });

  it('enumerates thirteen public routes (twelve handlers; the review list is mounted twice)', () => {
    expect(PUBLIC_ROUTES).toHaveLength(13);
  });

  it.each(PUBLIC_ROUTES)('$label is reachable with no token → $expected', async (route) => {
    let req = api()[route.method](route.path());
    if (route.cookies) req = req.set('Cookie', route.cookies());
    const res = await (route.body ? req.send(route.body()) : req.send());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(route.expected);
  });

  // A public handler must not read `req.user`; if it did, an unparseable token would break it.
  it.each(PUBLIC_ROUTES)('$label ignores a garbage Bearer token → $expected', async (route) => {
    let req = api()[route.method](route.path()).set('Authorization', 'Bearer not-a-jwt');
    if (route.cookies) req = req.set('Cookie', route.cookies());
    const res = await (route.body ? req.send(route.body()) : req.send());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(route.expected);
  });

  it.each(PUBLIC_ROUTES)('$label ignores a wrong-secret Bearer token → $expected', async (route) => {
    let req = api()[route.method](route.path())
      .set('Authorization', `Bearer ${tokenWithWrongSecret(GHOST)}`);
    if (route.cookies) req = req.set('Cookie', route.cookies());
    const res = await (route.body ? req.send(route.body()) : req.send());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(route.expected);
  });

  it('GET /api/auth/google redirects to Google rather than answering 401', async () => {
    const res = await api().get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
  });

  it('GET /api/auth/google/callback with no code redirects to the client, not 401', async () => {
    const res = await api().get('/api/auth/google/callback');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/login?error=oauth_failed');
  });

  it('POST /api/auth/refresh mints a new access token from the cookie alone', async () => {
    const res = await api().post('/api/auth/refresh').set('Cookie', [pub.refreshCookie]);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('POST /api/auth/refresh without the cookie is a controller 401, not the auth middleware', async () => {
    const res = await api().post('/api/auth/refresh');

    // Still public: it is the missing *cookie* being reported, not a missing Bearer token.
    expectErrorEnvelope(res, 401);
    expect(res.body.error.message).toBe('Refresh token not found');
  });

  it('GET /api/users/:id stays public but never leaks the private email field', async () => {
    const res = await api().get(`/api/users/${pub.user.id}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('email');
  });

  it('GET /api/projects/:id for an unknown id is 404, not 401', async () => {
    const res = await api().get('/api/projects/missing-project-id');

    expectErrorEnvelope(res, 404);
  });

  it('GET /api/users/:id for an unknown id is 404, not 401', async () => {
    const res = await api().get('/api/users/missing-user-id');

    expectErrorEnvelope(res, 404);
  });

  it('both mountings of the public review list behave identically', async () => {
    const viaUsers = await api().get(`/api/users/${pub.user.id}/reviews`);
    const viaReviews = await api().get(`/api/reviews/users/${pub.user.id}`);

    expect(viaUsers.status).toBe(200);
    expect(viaReviews.status).toBe(200);
    expect(viaReviews.body).toEqual(viaUsers.body);
  });
});

// ---------------------------------------------------------------------------------------------
// Authorization — ownership, and ownership checked *after* existence
// ---------------------------------------------------------------------------------------------

describe('ownership is checked after existence', () => {
  it('PATCH /api/projects/:id → 404 for a project owned by nobody', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .patch('/api/projects/missing-project-id')
      .send({ title: 'Edited' });

    expectErrorEnvelope(res, 404);
    expect(res.body.error.message).not.toMatch(/authoriz/i);
  });

  it('PATCH /api/projects/:id → 403 for a project owned by another client', async () => {
    const owner = await makeClient();
    const intruder = await makeClient();
    const project = await makeProject(owner.id, { title: 'Untouched' });

    const res = await authed(intruder).patch(`/api/projects/${project.id}`).send({ title: 'Hijacked' });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).title)
      .toBe('Untouched');
  });

  it('DELETE /api/projects/:id → 404 for a project owned by nobody', async () => {
    const client = await makeClient();

    const res = await authed(client).delete('/api/projects/missing-project-id');

    expectErrorEnvelope(res, 404);
  });

  it('DELETE /api/projects/:id → 403 for another client, and does not soft-delete it', async () => {
    const owner = await makeClient();
    const intruder = await makeClient();
    const project = await makeProject(owner.id);

    const res = await authed(intruder).delete(`/api/projects/${project.id}`);

    expectErrorEnvelope(res, 403);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).deletedAt)
      .toBeNull();
  });

  it('GET /api/contracts/:id → 404 for a contract owned by nobody', async () => {
    const user = await makeClient();

    const res = await authed(user).get('/api/contracts/missing-contract-id');

    expectErrorEnvelope(res, 404);
    expect(res.body.error.message).not.toMatch(/authoriz/i);
  });

  it('GET /api/contracts/:id → 403 for a user who is not a party to it', async () => {
    const { contract } = await makeContractChain();
    const outsider = await makeFreelancer();

    const res = await authed(outsider).get(`/api/contracts/${contract.id}`);

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
  });

  it('GET /api/contracts/:id → 200 for either party', async () => {
    const { client, freelancer, contract } = await makeContractChain();

    const asClient = await authed(client).get(`/api/contracts/${contract.id}`);
    const asFreelancer = await authed(freelancer).get(`/api/contracts/${contract.id}`);

    expect(asClient.status).toBe(200);
    expect(asFreelancer.status).toBe(200);
  });

  it('POST /api/contracts/:id/sign → 404 for a contract owned by nobody', async () => {
    const user = await makeClient();

    const res = await authed(user).post('/api/contracts/missing-contract-id/sign');

    expectErrorEnvelope(res, 404);
  });

  it('POST /api/contracts/:id/sign → 403 for an outsider, and records no signature', async () => {
    const { contract } = await makeContractChain();
    const outsider = await makeClient();

    const res = await authed(outsider).post(`/api/contracts/${contract.id}/sign`);

    expectErrorEnvelope(res, 403);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.clientSigned).toBe(false);
    expect(after.freelancerSigned).toBe(false);
    expect(after.status).toBe('PENDING');
  });

  it('POST /api/payments → 404 for a milestone that does not exist', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/payments').send({ milestoneId: 'missing-milestone-id' });

    expectErrorEnvelope(res, 404);
    expect(res.body.error.message).not.toMatch(/authoriz/i);
  });

  it('POST /api/payments → 403 for a milestone of another client\'s contract', async () => {
    const { milestone } = await makeContractChain({ status: 'ACTIVE' });
    const intruder = await makeClient();

    const res = await authed(intruder).post('/api/payments').send({ milestoneId: milestone.id });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('POST /api/payments/confirm → 404 for a payment owned by nobody', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/payments/confirm').send({
      paymentKey: 'test_payment_key',
      orderId: 'missing-order-id',
      amount: 4_000_000,
    });

    expectErrorEnvelope(res, 404);
    expect(res.body.error.message).not.toMatch(/authoriz/i);
  });

  it('POST /api/payments/confirm → 403 for another client\'s payment, before any provider call', async () => {
    const { client, milestone } = await makeContractChain({ status: 'ACTIVE' });
    const payment = await makePayment(milestone.id, client.id, { amount: 4_000_000 });
    const intruder = await makeClient();

    const res = await authed(intruder).post('/api/payments/confirm').send({
      paymentKey: 'test_payment_key',
      orderId: payment.orderId,
      amount: 4_000_000,
    });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
    // Still PENDING: the ownership check fires before the payment can be marked FAILED.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status)
      .toBe('PENDING');
  });

  it('POST /api/payments/dev-complete is refused outright while the bypass is disabled', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/payments/dev-complete')
      .send({ milestoneId: 'missing-milestone-id' });

    // The bypass guard answers before the milestone lookup, so it reveals nothing about which
    // milestones exist. `ALLOW_PAYMENT_BYPASS` is `'false'` in `vitest.config.ts`.
    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Payment bypass is disabled');
  });

  it('POST /api/reviews → 404 for a contract owned by nobody', async () => {
    const user = await makeClient();

    const res = await authed(user).post('/api/reviews').send({
      contractId: 'missing-contract-id',
      revieweeId: user.id,
      rating: 5,
      content: 'Great work',
    });

    expectErrorEnvelope(res, 404);
    expect(res.body.error.message).not.toMatch(/authoriz/i);
  });

  it('POST /api/reviews → 403 for a user who is not a party to the contract', async () => {
    const { client, freelancer, contract } = await makeContractChain({ status: 'COMPLETED' });
    const outsider = await makeClient();

    const res = await authed(outsider).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Never worked with them',
    });

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
    expect(await prisma.review.count()).toBe(0);

    // The 403 has to come from the party check and nothing else: the same request from the
    // contract's own client, differing only in who signs it, is accepted.
    const asParty = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Never worked with them',
    });

    expect(asParty.status).toBe(201);
    expect(await prisma.review.count()).toBe(1);
    expect((await prisma.review.findFirstOrThrow()).reviewerId).toBe(client.id);
  });

  // PATCH /api/contracts/:id is 410 for everyone, so it has no ownership rows here; the
  // 410 is asserted in contracts.test.ts.

  it.each([
    ['GET /api/contracts/:id/milestones', 'get', (id: string) => `/api/contracts/${id}/milestones`],
    ['PUT /api/contracts/:id/milestones', 'put', (id: string) => `/api/contracts/${id}/milestones`],
  ] as const)('%s → 404 for a missing contract, 403 for a non-party', async (_label, method, path) => {
    const { contract } = await makeContractChain();
    const outsider = await makeClient();
    const body = { milestones: [{ title: 'All', amount: 4_000_000, dueDate: '2099-01-01' }] };

    const missing = await authed(outsider)[method](path('missing-contract-id')).send(body);
    const foreign = await authed(outsider)[method](path(contract.id)).send(body);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Contract not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
  });

  it.each([
    ['GET /api/milestones/:id', 'get', '', 'CLIENT'],
    ['POST /api/milestones/:id/approve', 'post', '/approve', 'CLIENT'],
    ['POST /api/milestones/:id/reject', 'post', '/reject', 'CLIENT'],
    ['POST /api/milestones/:id/submissions', 'post', '/submissions', 'FREELANCER'],
    ['POST /api/milestones/:id/uploads', 'post', '/uploads', 'FREELANCER'],
    ['GET /api/milestones/:id/attachments/:attachmentId/download', 'get', '/attachments/missing-attachment-id/download', 'CLIENT'],
  ] as const)('%s → 404 for a missing milestone, 403 for a non-party', async (_label, method, suffix, role) => {
    const { milestone } = await makeContractChain({ status: 'ACTIVE' });
    const outsider = role === 'CLIENT' ? await makeClient() : await makeFreelancer();
    const body = {
      reason: 'Please fix the layout.',
      message: 'Done',
      files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
    };

    const missing = await authed(outsider)[method](`/api/milestones/missing-milestone-id${suffix}`).send(body);
    const foreign = await authed(outsider)[method](`/api/milestones/${milestone.id}${suffix}`).send(body);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Milestone not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
  });

  it('POST /api/milestones/:id/approve → 403 for a client of another contract even when SUBMITTED', async () => {
    const { milestone } = await makeContractChain({ status: 'ACTIVE' });
    await prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'SUBMITTED' } });
    const intruder = await makeClient();

    const res = await authed(intruder).post(`/api/milestones/${milestone.id}/approve`);

    expectErrorEnvelope(res, 403);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).status).toBe('SUBMITTED');
  });

  it('GET /api/settlements/:id → 404 for a missing settlement, 403 for another freelancer\'s', async () => {
    const owner = await makeFreelancer();
    const other = await makeFreelancer();
    const settlement = await prisma.settlement.create({
      data: {
        freelancerId: owner.id,
        periodStart: new Date('2026-10-18T15:00:00.000Z'),
        periodEnd: new Date('2026-10-25T15:00:00.000Z'),
        scheduledPayoutAt: new Date('2026-10-28T01:00:00.000Z'),
        itemCount: 0,
        grossAmount: 0,
        feeAmount: 0,
        feeVatAmount: 0,
        netAmount: 0,
      },
    });

    const missing = await authed(other).get('/api/settlements/missing-settlement-id');
    const foreign = await authed(other).get(`/api/settlements/${settlement.id}`);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Settlement not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
  });

  it.each([
    ['PATCH', 'patch', 'portfolio', 'Portfolio item not found'],
    ['DELETE', 'delete', 'portfolio', 'Portfolio item not found'],
    ['PATCH', 'patch', 'careers', 'Career not found'],
    ['DELETE', 'delete', 'careers', 'Career not found'],
  ] as const)('%s /api/users/me/%s/:id → 404 for a missing row, 403 for another freelancer\'s', async (_label, method, resource, notFound) => {
    const owner = await makeFreelancer();
    const intruder = await makeFreelancer();
    const row = resource === 'portfolio'
      ? await makePortfolioItem(owner.id)
      : await makeCareer(owner.id);
    const body = resource === 'portfolio' ? { title: 'Taken over' } : { position: 'Taken over' };

    const missing = await authed(intruder)[method](`/api/users/me/${resource}/missing-row-id`).send(body);
    const foreign = await authed(intruder)[method](`/api/users/me/${resource}/${row.id}`).send(body);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe(notFound);
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
    const stillThere = resource === 'portfolio'
      ? await prisma.portfolioItem.findUnique({ where: { id: row.id } })
      : await prisma.career.findUnique({ where: { id: row.id } });
    expect(stillThere).toMatchObject({ id: row.id, userId: owner.id });
    expect(JSON.stringify(stillThere)).not.toContain('Taken over');
  });

  it('GET /api/projects/:id/recommended-freelancers → 404 for a missing project, 403 for another client\'s', async () => {
    const owner = await makeClient();
    const outsider = await makeClient();
    const project = await makeProject(owner.id);

    const missing = await authed(outsider).get('/api/projects/missing-project-id/recommended-freelancers');
    const foreign = await authed(outsider).get(`/api/projects/${project.id}/recommended-freelancers`);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Project not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
  });

  it('GET /api/projects/:id/applications → 404 for a project owned by nobody', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/projects/missing-project-id/applications');

    expectErrorEnvelope(res, 404);
  });

  it('GET /api/projects/:id/applications → 403 for another client', async () => {
    const owner = await makeClient();
    const intruder = await makeClient();
    const project = await makeProject(owner.id);

    const res = await authed(intruder).get(`/api/projects/${project.id}/applications`);

    expectErrorEnvelope(res, 403);
    expect(res.body.error.message).toBe('Not authorized');
  });

  it('PATCH /api/notifications/:id/read → 404 for a notification belonging to someone else', async () => {
    const owner = await makeClient();
    const other = await makeClient();
    const notification = await prisma.notification.create({
      data: { userId: owner.id, type: 'APPLICATION_CREATED', title: 't', message: 'm' },
    });

    const res = await authed(other).patch(`/api/notifications/${notification.id}/read`);

    // Indistinguishable from a missing id, so it cannot be used to probe for others' ids.
    expectErrorEnvelope(res, 404);
    const missing = await authed(other).patch('/api/notifications/missing-notification-id/read');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(res.body.error.message);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt)
      .toBeNull();
  });

  it('GET /api/notifications only returns the caller\'s own notifications', async () => {
    const owner = await makeClient();
    const other = await makeClient();
    await prisma.notification.createMany({
      data: [
        { userId: owner.id, type: 'APPLICATION_CREATED', title: 'mine', message: 'm' },
        { userId: other.id, type: 'APPLICATION_CREATED', title: 'theirs', message: 'm' },
      ],
    });

    const res = await authed(owner).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].title).toBe('mine');
  });

  it('GET /api/payments only returns the caller\'s own payments', async () => {
    const mine = await makeContractChain({ status: 'ACTIVE' });
    const theirs = await makeContractChain({ status: 'ACTIVE' });
    await makePayment(mine.milestone.id, mine.client.id);
    await makePayment(theirs.milestone.id, theirs.client.id);

    const res = await authed(mine.client).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientId).toBe(mine.client.id);
  });

  it.each([
    ['GET /api/conversations/:id', 'get', ''],
    ['GET /api/conversations/:id/messages', 'get', '/messages'],
    ['POST /api/conversations/:id/messages', 'post', '/messages'],
    ['POST /api/conversations/:id/read', 'post', '/read'],
    ['DELETE /api/conversations/:id/messages/:messageId', 'delete', '/messages/:messageId'],
    ['POST /api/conversations/:id/uploads', 'post', '/uploads'],
    ['GET /api/conversations/:id/attachments/:attachmentId/download', 'get', '/attachments/missing-attachment-id/download'],
  ] as const)('%s → 404 for a missing conversation, 403 for a non-participant', async (_label, method, suffix) => {
    const { contract, freelancer } = await makeContractChain({ status: 'ACTIVE' });
    const conversation = await makeConversation(contract);
    const message = await makeMessage(conversation.id, freelancer.id);
    const outsider = await makeClient();
    const path = (id: string) => `/api/conversations/${id}${suffix.replace(':messageId', message.id)}`;

    const body = { body: 'Hello', files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', size: 10 }] };
    const missing = await authed(outsider)[method](path('missing-conversation-id')).send(body);
    const foreign = await authed(outsider)[method](path(conversation.id)).send(body);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Conversation not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
    expect(await prisma.message.count()).toBe(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deletedAt).toBeNull();
  });

  it("DELETE /api/conversations/:id/messages/:messageId → 404 for a missing or foreign message, 403 for the other participant's", async () => {
    const { contract, client, freelancer } = await makeContractChain({ status: 'ACTIVE' });
    const conversation = await makeConversation(contract);
    const theirs = await makeMessage(conversation.id, freelancer.id);
    const other = await makeContractChain({ status: 'ACTIVE' });
    const elsewhere = await makeMessage((await makeConversation(other.contract)).id, other.client.id);
    const url = (messageId: string) => `/api/conversations/${conversation.id}/messages/${messageId}`;

    const missing = await authed(client).delete(url('missing-message-id'));
    const foreign = await authed(client).delete(url(elsewhere.id));
    const notMine = await authed(client).delete(url(theirs.id));

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Message not found');
    expectErrorEnvelope(foreign, 404);
    expect(foreign.body.error.message).toBe('Message not found');
    expectErrorEnvelope(notMine, 403);
    expect(notMine.body.error.message).toBe('Not authorized');
    expect(await prisma.message.count({ where: { deletedAt: { not: null } } })).toBe(0);
  });

  it('GET /api/contracts/:id/conversation → 404 for a missing contract, 403 for a non-party', async () => {
    const { contract } = await makeContractChain();
    await makeConversation(contract);
    const outsider = await makeFreelancer();

    const missing = await authed(outsider).get('/api/contracts/missing-contract-id/conversation');
    const foreign = await authed(outsider).get(`/api/contracts/${contract.id}/conversation`);

    expectErrorEnvelope(missing, 404);
    expect(missing.body.error.message).toBe('Contract not found');
    expectErrorEnvelope(foreign, 403);
    expect(foreign.body.error.message).toBe('Not authorized');
  });

  it("GET /api/conversations lists only the caller's own conversations", async () => {
    const mine = await makeContractChain({ status: 'ACTIVE' });
    const theirs = await makeContractChain({ status: 'ACTIVE' });
    const conversation = await makeConversation(mine.contract);
    await makeConversation(theirs.contract);

    const res = await authed(mine.freelancer).get('/api/conversations');

    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversation.id]);
  });

  /**
   * Local chain builder: the shared `makeContractScenario` helper is fine, but these tests
   * need the contract status to vary and the ids returned individually.
   */
  async function makeContractChain(contract: { status?: 'PENDING' | 'ACTIVE' | 'COMPLETED' } = {}) {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const project = await makeProject(client.id, { status: 'CLOSED' });
    const application = await makeApplication(project.id, freelancer.id, { status: 'ACCEPTED' });
    const created = await makeContract(
      {
        projectId: project.id,
        applicationId: application.id,
        clientId: client.id,
        freelancerId: freelancer.id,
      },
      contract,
    );
    const milestone = await makeMilestone(created.id, {
      status: created.status === 'COMPLETED' ? 'APPROVED' : 'PENDING',
    });

    return { client, freelancer, project, application, contract: created, milestone };
  }
});

// Soft delete is asserted in soft-delete.test.ts.

// ---------------------------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------------------------

describe('error envelope', () => {
  /**
   * The full-shape assertion, one status class at a time. `expectErrorEnvelope` already refuses
   * extra keys; these pin the exact message too, so a controller cannot satisfy the envelope by
   * answering with a different error than the one the status implies.
   */
  function expectExactEnvelope(res: ApiResponse, status: number, message: string) {
    expectErrorEnvelope(res, status);
    expect(res.body).toEqual({ error: { message } });
  }

  it('is exactly { error: { message } } on 401', async () => {
    const res = await api().get('/api/users/me');

    expectExactEnvelope(res, 401, 'Authentication required');
  });

  it('is exactly { error: { message } } on 403', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get('/api/users/me/projects');

    expectExactEnvelope(res, 403, 'Only clients can view their projects');
  });

  it('is exactly { error: { message } } on 404', async () => {
    const res = await api().get('/api/users/missing-user-id');

    expectExactEnvelope(res, 404, 'User not found');
  });

  it('is exactly { error: { message } } on 400', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'nobody@test.local' });

    expectExactEnvelope(res, 400, 'password: Password is required');
  });

  it('is exactly { error: { message } } on 409', async () => {
    const existing = await makeClient();

    const res = await api().post('/api/auth/signup').send({
      email: existing.email,
      password: 'password123',
      name: 'Duplicate',
      role: 'CLIENT',
    });

    expectExactEnvelope(res, 409, 'Email already in use');
  });

  // body-parser's own message quotes the JSON parser (`Expected property name or '}' in JSON at
  // position 2 …`); the API answers one fixed sentence instead.
  it.each([
    ['a truncated object', '{"email":'],
    ['an unquoted key', '{email: "a@b.com"}'],
  ])('answers a malformed JSON body (%s) with a fixed 400 message', async (_label, raw) => {
    const res = await api().post('/api/auth/login').set('Content-Type', 'application/json').send(raw);

    expectExactEnvelope(res, 400, 'Request body must be valid JSON');
  });

  it('rejects a malformed JSON body before authentication', async () => {
    const res = await api().post('/api/projects').set('Content-Type', 'application/json').send('{"title":');

    expectExactEnvelope(res, 400, 'Request body must be valid JSON');
  });

  it('never includes a stack trace or extra keys alongside the message', async () => {
    const res = await api().post('/api/auth/select-role').send({ role: 'CLIENT' });

    expect(res.body).toEqual({ error: { message: 'Authentication required' } });
    // `errorHandler` renders `{ error: { message } }` and nothing else, so none of the
    // Error-shaped properties may survive serialization.
    for (const leak of ['stack', 'statusCode', 'status', 'name', 'success', 'code']) {
      expect(res.body).not.toHaveProperty(leak);
      expect(res.body.error).not.toHaveProperty(leak);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Error envelope, continued — the routes that never reach `errorHandler` at all
// ---------------------------------------------------------------------------------------------

describe('unmatched paths and methods bypass errorHandler', () => {
  /**
   * There is no terminal 404 handler after `errorHandler` in `src/index.ts`, and `errorHandler`
   * is an *error* middleware — it only runs for a request that reached a handler which called
   * `next(err)`. A request matching no route falls off the end of the stack to Express's
   * `finalhandler`, which answers 404 with an **HTML** document — not the
   * `{ error: { message } }` envelope every other error response uses.
   *
   * Whether to add a terminal 404 handler or to scope the envelope rule to handled routes is an
   * open product question, so these pin today's behavior rather than asserting it is right. If
   * the answer is "add the handler", these are the tests to invert.
   */
  const UNMATCHED = [
    {
      // Was `GET /api/contracts` until the contract list endpoint gave that router an index route.
      label: 'GET /api/users (mounted router, no index route)',
      method: 'get' as HttpMethod,
      path: '/api/users',
      expectedText: 'Cannot GET /api/users',
    },
    {
      label: 'DELETE /api/users/me (path exists, method does not)',
      method: 'delete' as HttpMethod,
      path: '/api/users/me',
      expectedText: 'Cannot DELETE /api/users/me',
    },
    {
      label: 'GET /api/nope (no router mounted)',
      method: 'get' as HttpMethod,
      path: '/api/nope',
      expectedText: 'Cannot GET /api/nope',
    },
  ];

  it.each(UNMATCHED)('$label → 404 whose body is not the error envelope', async (route) => {
    const res = await api()[route.method](route.path).send();

    expect(res.status).toBe(404);
    // The envelope violation, stated positively so it is unambiguous what changes if the open
    // question is decided the other way: HTML, no parsed JSON body, no `error` key anywhere.
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toEqual({ error: { message: expect.any(String) } });
    expect(res.body).not.toHaveProperty('error');
    expect(res.body).toEqual({});
    expect(res.text).toContain(route.expectedText);
  });

  it('an unmatched method is a 404 rather than a 405, and changes nothing', async () => {
    // Worth separating from the shape question: `DELETE /api/users/me` looks like an account
    // deletion endpoint and there is none, so it must not be mistaken for a no-op success.
    const client = await makeClient();

    const res = await authed(client).delete('/api/users/me');

    expect(res.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt)
      .toBeNull();
  });

  it('authentication is never consulted for an unmatched path', async () => {
    // `authenticate` is mounted per route, so an unmatched path cannot reach it: a bad token
    // gets the same 404 as no token, and a valid one gets no better.
    const client = await makeClient();

    const anonymous = await api().get('/api/nope');
    const garbage = await api().get('/api/nope').set('Authorization', 'Bearer not-a-jwt');
    const valid = await authed(client).get('/api/nope');

    for (const res of [anonymous, garbage, valid]) {
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('error');
    }
  });
});
