# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

WorkBridge (프리랜서 매칭 플랫폼) is a freelancer-matching marketplace connecting clients (`CLIENT`) with freelancers (`FREELANCER`). It covers the full outsourcing flow: project discovery → application → contract signing → AI pricing analysis → payment → mutual review. It is a two-package repo (not a workspace/monorepo tool): `workbridge-server` (Express + Prisma API, **TypeScript**) and `workbridge-client` (Next.js 14 App Router, still JSX). Documentation in `docs/` (Korean) is the source of truth for requirements — `docs/API.md`, `docs/DATABASE.md`, `docs/ENV.md`. **`docs/BEHAVIOR.md` (English) specifies intended API behavior** and is the oracle for tests; where the implementation disagrees it is marked as a known divergence there, so do not treat current behavior as the spec.

## Commands

Run these from inside the respective package directory.

**Server** (`workbridge-server/`):
```bash
npm run dev                          # tsx watch src/index.ts on http://localhost:4000
npm run typecheck                    # tsc --noEmit (covers src/ and test/)
npm test                             # vitest behavior suite — needs a real Postgres test db
bash scripts/test-db.sh              # create + migrate workbridge_test (prints its URL)
npx prisma migrate dev --name <name> # create + apply a migration (updates schema)
npm run db:push                      # push schema without a migration (prototyping)
npm run db:generate                  # regenerate Prisma client after schema edits
npm run db:seed                      # seed data (prisma/seed.js; see docs/SEED_DATA.md)
```

**Client** (`workbridge-client/`):
```bash
npm run dev     # next dev on http://localhost:3000
npm run build   # production build — the client's correctness check
npm run lint     # eslint (next lint)
```

The **server has a behavior test suite** (`test/`, vitest + supertest) asserted against `docs/BEHAVIOR.md`; known divergences are pinned with `it.fails`. It runs against a **real Postgres database**, not mocks — `scripts/test-db.sh` creates and migrates `workbridge_test`, or point `TEST_DATABASE_URL` at your own. The helpers truncate every table between tests, so never aim it at a database you care about. Cross-cutting concerns are tested once, centrally: the 401/403/ownership matrix lives in `test/authorization.test.ts` and soft-delete behavior in `test/soft-delete.test.ts` — don't re-assert those per endpoint. The client has **no tests**; `npm run build` is its correctness check, plus manual flow testing. CI (`.github/workflows/ci.yml`) runs the server typecheck, `prisma validate`, and the test suite against a Postgres service container. Prisma client is auto-generated on `npm install` via `postinstall`; its types must exist before typecheck.

To exercise the running app, use the `run-workbridge` skill. Its `drive.sh` screenshot checks only assert that a non-empty PNG was written — open the images to judge them.

## Architecture

### Backend (`workbridge-server/src/`)
Layered Express app (TypeScript): `routes → controllers → lib` for the original domains, `routes → controllers → services → lib` for the expansion domains (see "Intended mix" below):
- **`index.ts`** — builds the Express app, mounts routers under `/api/*`, and `export default app` for Vercel serverless. It calls `app.listen()` and starts the dev job worker only when `NODE_ENV` is neither `production` nor `test`. `import 'dotenv/config'` **must stay the first import** — several modules read `process.env` at module-evaluation time. Note both `projects.routes.ts` and `applications.routes.ts` mount on `/api/projects` (applications are nested under projects), and `users.routes.ts` then `profile.routes.ts` both mount on `/api/users` — the first router wins on overlapping paths (`/me/*`, `/:id`). **Both mount orders are load-bearing**; add new `/api/users/me/<x>` routes to `profile.routes.ts` and never reorder.
- **`src/types/index.ts`** holds the shared types; **`src/env.ts`** holds typed `process.env` access (lazy getters, so a missing var still fails on the path that needs it rather than at boot). Import from these rather than redefining. Prisma generates every model, enum, `WhereInput`, and `UpdateInput` type — reuse those, never hand-roll them.
- **Controllers** are `async (req, res, next)` functions that `throw new AppError(message, statusCode)` (from `lib/errors.ts`) for HTTP errors, wrapped in a `try/catch` that forwards via `next(err)`. The global `errorHandler` (last middleware) converts these to `{ error: { message } }`. Only status 500 is logged. Do not send error responses directly from controllers, and **do not annotate handlers as `Promise<void>`** — several `return res.json(...)` mid-function, which is a `Response`.
- **Auth** (`middlewares/auth.ts`): `authenticate` verifies the Bearer access token and sets `req.user`; `requireRole(...roles: Role[])` gates by `Role`. Access tokens are short-lived (15m); the refresh token lives in an httpOnly cookie and is exchanged at `POST /api/auth/refresh`. **`Express.Request.user` is augmented as non-optional**, so `req.user.id` needs no guard — but that means the type will not warn you on the 12 public handlers (13 routes; the list is in `src/types/index.ts`), where it is `undefined` at runtime. One of them is `internal.controller`'s `runJobs` (`POST /api/internal/jobs/run`), guarded by an `X-Internal-Token` header instead of a JWT — it must never read `req.user` either. Never read `req.user` in a handler that is not behind `authenticate`.
- **Multi-step state changes use `prisma.$transaction`.** The canonical example is `applications.controller.ts` accepting an application: in one transaction it updates the application, rejects competing applications (`updateMany`), creates the `Contract` and its default `Milestone`, closes recruitment on the `Project`, fans out notifications, and opens the contract's `Conversation` with its first system message. Preserve this atomicity when touching contract/application/payment flows. A helper that must work both inside and outside a transaction takes `PrismaTransactionClient` (see `lib/projectLifecycle.ts`).
- **`lib/` holds business logic** kept out of controllers — treat these as the domain rules:
  - `projectLifecycle.ts` — status transitions (`UPCOMING`→`OPEN`→`CLOSED`) driven by `recruitmentStartDate`/`deadline`; `closeExpiredOpenProjects()` is invoked lazily on project list/read to keep statuses current; when a job runner is active the `project.lifecycleSweep` job also runs it every 10 minutes, but production has no resident worker, so the lazy calls stay. **This means `GET /api/projects` and `GET /api/projects/:id` write rows** — they are not read-only.
  - `skills.ts` — skill normalization via `SKILL_ALIASES` (e.g. PostgreSQL→SQL) plus search-term expansion, used for project↔freelancer matching.
  - `profileCompletion.ts` — role-specific required-field checks gating what a user can do.
  - `money.ts` (fees, VAT, rounding), `time.ts` (KST calendar), `locks.ts` (`lockUserRow`), `recommendations.ts`, `notifications/*` (`notify`, channel policy, templates), plus infrastructure (`logger`, `rateLimit`, `mail/`, `payout/`).
- **AI pricing analysis** (`projects.controller.ts` `analyzeProject`): calls OpenAI `gpt-4o-mini` with `response_format: { type: 'json_object' }`, then normalizes/sanitizes the returned JSON before persisting to the `PricingAnalysis` model. Always normalize model output — do not trust its shape.
- **File uploads**: Multer `memoryStorage` → the `workbridge` Supabase Storage bucket, returning a public URL. The pre-existing profile image goes through `middlewares/upload.ts` (5MB, images only, errors can surface as 500 — D6); the expansion routes use `middlewares/attachmentUpload.ts` (`attachmentUpload`: 5 files × 10MB; `imageUpload`: one 5MB image), which maps limits to 413/400 and storage failures to 502.

### Frontend (`workbridge-client/src/`)
Next.js 14 App Router (JSX, not TS), Tailwind, Zustand:
- **`lib/api.js`** is the single Axios instance. Its response interceptor transparently handles `401` by calling `/api/auth/refresh` once, queuing concurrent failed requests, retrying them with the new access token, and redirecting to `/login` on refresh failure. Always import this `api` for backend calls rather than calling axios/fetch directly.
- **API base URL is environment-split**: in the browser `getBaseURL()` returns `''` (same-origin `/api/*` requests); during SSR it uses `NEXT_PUBLIC_API_URL`. The browser therefore expects the API reachable on the same origin — keep this in mind when the API host changes.
- **`store/authStore.js`** (Zustand) mirrors auth state into `localStorage` (`accessToken`, `user`); call `initAuth()` on load to rehydrate. `store/projectStore.js` holds list filter/pagination state.
- **`middleware.js`** does route protection by checking the `refreshToken` cookie: unauthenticated users hitting `protectedRoutes` (`/profile`, `/my`, `/projects/new`, `/contracts`, `/settlements`, `/messages`, `/payments`) are redirected to `/login?redirect=...`; logged-in users on `/login`/`/signup` are bounced home. This is coarse cookie-presence gating, not verification — controllers remain the real authorization boundary.

### Data model (`workbridge-server/prisma/schema.prisma`)
PostgreSQL (Supabase). Core chain: `User` (CLIENT/FREELANCER) → `Project` → `Application` → `Contract` → `Payment` → `Review`. Key invariants: `Project.contract` is 1:1 (`@unique`); payments are **per milestone** — a `Contract` has many `Milestone`s and `Payment`s, `Payment.milestoneId` and `SettlementItem.milestoneId` are unique, and a contract completes automatically when its last milestone is approved (`PATCH /api/contracts/:id` answers 410); an `Application` is unique per `(projectId, freelancerId)`; a `Review` is unique per `(contractId, reviewerId)` (one review per party). Deletion is **soft** via `deletedAt` on `User`/`Project` — always filter `deletedAt: null` in queries.

## Conventions & Gotchas
- **`tsconfig.json` includes `src/`, `test/`, and `vitest.config.ts` — but not `prisma/`** — `prisma/seed.js` is deliberately left as plain CommonJS JavaScript, run untranspiled by `node`. Don't convert it.
- **`vercel.json` hardcodes the entry path twice** (`builds[].src` and `routes[].dest`) — renaming `src/index.ts` requires changing both. `@vercel/node` transpiles TypeScript natively, so there is deliberately no build step and no `dist/`; the Vercel Build Command lives in the dashboard, not the repo, so avoid changes that would require editing it.
- After editing `schema.prisma`, run a migration (or `db:push`) **and** `db:generate` before the new fields/models are usable.
- **Payment bypass**: `ALLOW_PAYMENT_BYPASS` (server) + `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` (client) enable a "dev payment complete" shortcut around the TossPayments sandbox for local/demo use. Both must stay `false` in production.
- **Email is log-only.** No real mail service is connected: with `MAIL_PROVIDER` unset or `log`, every email is one `mail.sent` info line in the server log (address and full text included — dev only). Create notifications only through `notify()`/`notifyMany()` (`lib/notifications/notify.ts`) inside the state change's transaction; it applies the per-type channel policy (`lib/notifications/policy.ts`) and the recipient's preferences, and writes the `EmailDelivery` + `notification.email` job. The four pre-existing types keep their Korean wording inline in the old controllers on purpose.
- Google OAuth `GOOGLE_CALLBACK_URL` points at the **frontend** callback (`/api/auth/google/callback`), which relays to the backend.

## Expansion rules (not visible from any single file)
- **Intended mix — do not "clean it up".** Service layer (`src/services/`), zod `validate()` (`src/schemas/`), `requireActiveUser` and `attachmentUpload` exist only on the expansion routes (milestones, settlements, payout account, contract list, conversations, portfolio/careers, recommendations, notification preferences). The original controllers (auth, users, projects, applications, contracts, payments, reviews, notifications) keep inline logic and manual checks on purpose: never refactor them into services, add zod, or mount `requireActiveUser` on old routes — the `it.fails` pins (e.g. D12 in `soft-delete.test.ts` `mutations`) depend on that. New routes use `authenticate → requireActiveUser → requireRole → validate` and add a row to `guardedMutations`.
- **Job queue** (`src/jobs/`, Postgres `Job` table). Enqueue with `enqueueJob(tx, …)` inside the same transaction as the state change that causes the job. Dedupe with `dedupeKey` (it is `createMany({ skipDuplicates })`); never `create` and catch P2002 inside an interactive transaction — Postgres aborts the whole transaction. Handlers use `ctx.now`, never `new Date()`. The dev worker runs from `index.ts` (`JOB_WORKER_ENABLED`); **production has no worker**, only `POST /api/internal/jobs/run` and `npm run jobs:run`, so auto-approval, settlements and email do not run there until an external scheduler exists.
- **Money and time.** Every fee, VAT and rounding calculation goes through `lib/money.ts` (integer won; the `Float` columns are intended debt — don't migrate them). Calendar rules ("today", due dates, the weekly settlement batch) use the fixed +9 offset in `lib/time.ts` — no timezone library, and no host-timezone `Date` getters (`getDate()`, `setHours()`…) for calendar logic. Functions take `now` as an argument so tests control time.
- **Per-user serialization.** `lockUserRow(tx, userId)` (`lib/locks.ts`) as a transaction's first statement serializes a user's payout-account writes with the payout decision, portfolio/career writes and notification-preference writes. Keep it first; the race tests depend on it.
- **Logging.** Use `lib/logger.ts`, not `console.*`. `error` level is reserved for `errorHandler`'s 500s and job failures — the suite asserts "a 500 is logged exactly once" with a `console.error` spy; use `warn`/`info` everywhere else.
- **Test helpers.** Build fixtures per test with `test/helpers/factories.ts`. Drive the queue with `runJobs(now)`/`jobsOf(type)` from `test/helpers/jobs.ts` (`runDueJobs({ now })`), never fake timers (they don't mix with Prisma). Mock Supabase with `vi.mock('@supabase/supabase-js', …)` at the top of each test file that uploads; `test/setup.ts` must never import the app, or those mocks register too late.
