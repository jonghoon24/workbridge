# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

WorkBridge (프리랜서 매칭 플랫폼) is a freelancer-matching marketplace connecting clients (`CLIENT`) with freelancers (`FREELANCER`). It covers the full outsourcing flow: project discovery → application → contract signing → AI pricing analysis → payment → mutual review. It is a two-package repo (not a workspace/monorepo tool): `workbridge-server` (Express + Prisma API) and `workbridge-client` (Next.js 14 App Router). Documentation in `docs/` (Korean) is the source of truth for requirements — `docs/API.md`, `docs/DATABASE.md`, `docs/ENV.md`.

## Commands

Run these from inside the respective package directory.

**Server** (`workbridge-server/`):
```bash
npm run dev                          # nodemon on http://localhost:4000
npx prisma migrate dev --name <name> # create + apply a migration (updates schema)
npm run db:push                      # push schema without a migration (prototyping)
npm run db:generate                  # regenerate Prisma client after schema edits
npm run db:seed                      # seed data (prisma/seed.js; see docs/SEED_DATA.md)
```

**Client** (`workbridge-client/`):
```bash
npm run dev     # next dev on http://localhost:3000
npm run build   # production build — the primary correctness check (no test suite exists)
npm run lint     # eslint (next lint)
```

There is **no automated test suite** in either package. Verify changes with `npm run build` (client), `npx prisma validate` (server schema), and manual flow testing. Prisma client is auto-generated on `npm install` via the `postinstall` hook.

## Architecture

### Backend (`workbridge-server/src/`)
Layered Express app with a strict `routes → controllers → lib` flow:
- **`index.js`** — builds the Express app, mounts routers under `/api/*`, and `export default app` for Vercel serverless. It only calls `app.listen()` when `NODE_ENV !== 'production'`. Note both `projects.routes.js` and `applications.routes.js` mount on `/api/projects` (applications are nested under projects).
- **Controllers** are `async (req, res, next)` functions. They **never** try/catch for HTTP errors — instead they `throw new AppError(message, statusCode)` (from `lib/errors.js`), which the global `errorHandler` (last middleware) converts to `{ error: { message } }`. Only status 500 is logged. Follow this pattern; do not send error responses directly from controllers.
- **Auth** (`middlewares/auth.js`): `authenticate` verifies the Bearer access token and sets `req.user`; `requireRole(...roles)` gates by `Role`. Access tokens are short-lived (15m); the refresh token lives in an httpOnly cookie and is exchanged at `POST /api/auth/refresh`.
- **Multi-step state changes use `prisma.$transaction`.** The canonical example is `applications.controller.js` accepting an application: in one transaction it updates the application, rejects competing applications (`updateMany`), creates the `Contract`, closes recruitment on the `Project`, and fans out `Notification` rows. Preserve this atomicity when touching contract/application/payment flows.
- **`lib/` holds business logic** kept out of controllers — treat these as the domain rules:
  - `projectLifecycle.js` — status transitions (`UPCOMING`→`OPEN`→`CLOSED`) driven by `recruitmentStartDate`/`deadline`; `closeExpiredOpenProjects()` is invoked lazily on project list/read to keep statuses current (there is no cron).
  - `skills.js` — skill normalization via `SKILL_ALIASES` (e.g. PostgreSQL→SQL) plus search-term expansion, used for project↔freelancer matching.
  - `profileCompletion.js` — role-specific required-field checks gating what a user can do.
- **AI pricing analysis** (`projects.controller.js` `analyzeProject`): calls OpenAI `gpt-4o-mini` with `response_format: { type: 'json_object' }`, then normalizes/sanitizes the returned JSON before persisting to the `PricingAnalysis` model. Always normalize model output — do not trust its shape.
- **File uploads** (`middlewares/upload.js`): Multer `memoryStorage` (5MB, images only) → `uploadToSupabase()` streams the buffer to the `workbridge` Supabase Storage bucket and returns a public URL.

### Frontend (`workbridge-client/src/`)
Next.js 14 App Router (JSX, not TS), Tailwind, Zustand:
- **`lib/api.js`** is the single Axios instance. Its response interceptor transparently handles `401` by calling `/api/auth/refresh` once, queuing concurrent failed requests, retrying them with the new access token, and redirecting to `/login` on refresh failure. Always import this `api` for backend calls rather than calling axios/fetch directly.
- **API base URL is environment-split**: in the browser `getBaseURL()` returns `''` (same-origin `/api/*` requests); during SSR it uses `NEXT_PUBLIC_API_URL`. The browser therefore expects the API reachable on the same origin — keep this in mind when the API host changes.
- **`store/authStore.js`** (Zustand) mirrors auth state into `localStorage` (`accessToken`, `user`); call `initAuth()` on load to rehydrate. `store/projectStore.js` holds list filter/pagination state.
- **`middleware.js`** does route protection by checking the `refreshToken` cookie: unauthenticated users hitting `protectedRoutes` (`/profile`, `/my`, `/projects/new`, `/contracts`) are redirected to `/login?redirect=...`; logged-in users on `/login`/`/signup` are bounced home. This is coarse cookie-presence gating, not verification — controllers remain the real authorization boundary.

### Data model (`workbridge-server/prisma/schema.prisma`)
PostgreSQL (Supabase). Core chain: `User` (CLIENT/FREELANCER) → `Project` → `Application` → `Contract` → `Payment` → `Review`. Key invariants: `Project.contract` and `Contract.payment` are 1:1 (`@unique`); an `Application` is unique per `(projectId, freelancerId)`; a `Review` is unique per `(contractId, reviewerId)` (one review per party). Deletion is **soft** via `deletedAt` on `User`/`Project` — always filter `deletedAt: null` in queries.

## Conventions & Gotchas
- **ES modules everywhere on the server** (`"type": "module"`) — use `import`, and include the `.js` extension in relative imports.
- After editing `schema.prisma`, run a migration (or `db:push`) **and** `db:generate` before the new fields/models are usable.
- **Payment bypass**: `ALLOW_PAYMENT_BYPASS` (server) + `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` (client) enable a "dev payment complete" shortcut around the TossPayments sandbox for local/demo use. Both must stay `false` in production.
- Google OAuth `GOOGLE_CALLBACK_URL` points at the **frontend** callback (`/api/auth/google/callback`), which relays to the backend.
