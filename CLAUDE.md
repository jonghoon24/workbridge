# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

WorkBridge (프리랜서 매칭 플랫폼) is a freelancer-matching marketplace connecting clients (`CLIENT`) with freelancers (`FREELANCER`). It covers the full outsourcing flow: project discovery → application → contract signing → AI pricing analysis → payment → mutual review. It is a two-package repo (not a workspace/monorepo tool): `workbridge-server` (Express + Prisma API, **TypeScript**) and `workbridge-client` (Next.js 14 App Router, still JSX). Documentation in `docs/` (Korean) is the source of truth for requirements — `docs/API.md`, `docs/DATABASE.md`, `docs/ENV.md`.

## Commands

Run these from inside the respective package directory.

**Server** (`workbridge-server/`):
```bash
npm run dev                          # tsx watch src/index.ts on http://localhost:4000
npm run typecheck                    # tsc --noEmit — the primary correctness check
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

There is **no automated test suite** in either package. Verify changes with `npm run typecheck` (server — the strongest gate), `npm run build` (client), `npx prisma validate` (server schema), and manual flow testing. `.github/workflows/typecheck.yml` runs `prisma generate` then `tsc --noEmit` on every PR; it is the only CI in the repo. Prisma client is auto-generated on `npm install` via the `postinstall` hook — **its generated types must exist before typecheck**, since the whole data model is inherited from them.

To exercise the running app end-to-end, use the `run-workbridge` skill (`.claude/skills/run-workbridge/`); its `drive.sh` runs four API checks plus two screenshots. Only the four API checks are meaningful — the screenshot assertions merely confirm a non-empty PNG was written, so open the images to judge them.

## Architecture

### Backend (`workbridge-server/src/`)
Layered Express app (TypeScript) with a strict `routes → controllers → lib` flow:
- **`index.ts`** — builds the Express app, mounts routers under `/api/*`, and `export default app` for Vercel serverless. It only calls `app.listen()` when `NODE_ENV !== 'production'`. `import 'dotenv/config'` **must stay the first import** — several modules read `process.env` at module-evaluation time. Note both `projects.routes.ts` and `applications.routes.ts` mount on `/api/projects` (applications are nested under projects), and **that mount order is load-bearing**.
- **`src/types/index.ts`** holds the shared types; **`src/env.ts`** holds typed `process.env` access (lazy getters, so a missing var still fails on the path that needs it rather than at boot). Import from these rather than redefining. Prisma generates every model, enum, `WhereInput`, and `UpdateInput` type — reuse those, never hand-roll them.
- **Controllers** are `async (req, res, next)` functions that `throw new AppError(message, statusCode)` (from `lib/errors.ts`) for HTTP errors, wrapped in a `try/catch` that forwards via `next(err)`. The global `errorHandler` (last middleware) converts these to `{ error: { message } }`. Only status 500 is logged. Do not send error responses directly from controllers, and **do not annotate handlers as `Promise<void>`** — several `return res.json(...)` mid-function, which is a `Response`.
- **Auth** (`middlewares/auth.ts`): `authenticate` verifies the Bearer access token and sets `req.user`; `requireRole(...roles: Role[])` gates by `Role`. Access tokens are short-lived (15m); the refresh token lives in an httpOnly cookie and is exchanged at `POST /api/auth/refresh`. **`Express.Request.user` is augmented as non-optional**, so `req.user.id` needs no guard — but that means the type will not warn you on the 9 public routes, where it is `undefined` at runtime. Never read `req.user` in a handler that is not behind `authenticate`.
- **Multi-step state changes use `prisma.$transaction`.** The canonical example is `applications.controller.ts` accepting an application: in one transaction it updates the application, rejects competing applications (`updateMany`), creates the `Contract`, closes recruitment on the `Project`, and fans out `Notification` rows. Preserve this atomicity when touching contract/application/payment flows. A helper that must work both inside and outside a transaction takes `PrismaTransactionClient` (see `lib/projectLifecycle.ts`).
- **`lib/` holds business logic** kept out of controllers — treat these as the domain rules:
  - `projectLifecycle.ts` — status transitions (`UPCOMING`→`OPEN`→`CLOSED`) driven by `recruitmentStartDate`/`deadline`; `closeExpiredOpenProjects()` is invoked lazily on project list/read to keep statuses current (there is no cron). **This means `GET /api/projects` and `GET /api/projects/:id` write rows** — they are not read-only.
  - `skills.ts` — skill normalization via `SKILL_ALIASES` (e.g. PostgreSQL→SQL) plus search-term expansion, used for project↔freelancer matching.
  - `profileCompletion.ts` — role-specific required-field checks gating what a user can do.
- **AI pricing analysis** (`projects.controller.ts` `analyzeProject`): calls OpenAI `gpt-4o-mini` with `response_format: { type: 'json_object' }`, then normalizes/sanitizes the returned JSON before persisting to the `PricingAnalysis` model. Always normalize model output — do not trust its shape. The response `content` is typed `string | null` and is guarded before `JSON.parse`.
- **File uploads** (`middlewares/upload.ts`): Multer `memoryStorage` (5MB, images only) → `uploadToSupabase()` streams the buffer to the `workbridge` Supabase Storage bucket and returns a public URL.

### Frontend (`workbridge-client/src/`)
Next.js 14 App Router (JSX, not TS), Tailwind, Zustand:
- **`lib/api.js`** is the single Axios instance. Its response interceptor transparently handles `401` by calling `/api/auth/refresh` once, queuing concurrent failed requests, retrying them with the new access token, and redirecting to `/login` on refresh failure. Always import this `api` for backend calls rather than calling axios/fetch directly.
- **API base URL is environment-split**: in the browser `getBaseURL()` returns `''` (same-origin `/api/*` requests); during SSR it uses `NEXT_PUBLIC_API_URL`. The browser therefore expects the API reachable on the same origin — keep this in mind when the API host changes.
- **`store/authStore.js`** (Zustand) mirrors auth state into `localStorage` (`accessToken`, `user`); call `initAuth()` on load to rehydrate. `store/projectStore.js` holds list filter/pagination state.
- **`middleware.js`** does route protection by checking the `refreshToken` cookie: unauthenticated users hitting `protectedRoutes` (`/profile`, `/my`, `/projects/new`, `/contracts`) are redirected to `/login?redirect=...`; logged-in users on `/login`/`/signup` are bounced home. This is coarse cookie-presence gating, not verification — controllers remain the real authorization boundary.

### Data model (`workbridge-server/prisma/schema.prisma`)
PostgreSQL (Supabase). Core chain: `User` (CLIENT/FREELANCER) → `Project` → `Application` → `Contract` → `Payment` → `Review`. Key invariants: `Project.contract` and `Contract.payment` are 1:1 (`@unique`); an `Application` is unique per `(projectId, freelancerId)`; a `Review` is unique per `(contractId, reviewerId)` (one review per party). Deletion is **soft** via `deletedAt` on `User`/`Project` — always filter `deletedAt: null` in queries.

## Conventions & Gotchas
- **The server compiles to CommonJS** — there is no `"type": "module"` in `package.json`. You still write `import`/`export` in the TypeScript source; `tsc` downlevels it to `require()`. Relative imports are **extensionless** (`import { AppError } from '../lib/errors'`). `esModuleInterop` is on, so default-importing CJS packages works normally.
  - Historical note: the server was ESM while it was plain JavaScript, because `import` syntax in plain `.js` *requires* `"type": "module"`, which in turn forces explicit `.js` extensions on every relative import. TypeScript decouples syntax from output format, so that constraint disappeared with the migration and the extensions were dropped.
- **`tsconfig.json` scopes `include` to `src/` only.** `prisma/seed.js` therefore stays plain JavaScript, and is written in **CommonJS (`require`)** because `node` runs it directly with no transpilation — `import` syntax there would be a `SyntaxError`.
- **`prisma/seed.js` deletes `Notification` rows first.** It holds a `userId` foreign key, so `user.deleteMany()` fails with Prisma `P2003` if any survive. The app creates notifications whenever an application is accepted, so re-seeding after using the app depends on this ordering.
- **`vercel.json` hardcodes `src/index.ts` twice** (`builds[].src` and `routes[].dest`). If the entry point is ever renamed, both must change. `@vercel/node` transpiles TypeScript natively — there is no build step and no `dist/`, and the Vercel dashboard Build Command (`npx prisma generate`) is not version-controlled, so avoid changes that would require editing it.
- After editing `schema.prisma`, run a migration (or `db:push`) **and** `db:generate` before the new fields/models are usable.
- **Payment bypass**: `ALLOW_PAYMENT_BYPASS` (server) + `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` (client) enable a "dev payment complete" shortcut around the TossPayments sandbox for local/demo use. Both must stay `false` in production.
- Google OAuth `GOOGLE_CALLBACK_URL` points at the **frontend** callback (`/api/auth/google/callback`), which relays to the backend.
