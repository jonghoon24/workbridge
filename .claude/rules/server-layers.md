---
paths:
  - "workbridge-server/src/**/*.ts"
---

# Server layers (workbridge-server/src)

## Old vs expansion routes — the mix is intended

- Pre-existing domains (auth, users, projects, applications, contracts, payments, reviews,
  notifications) keep inline logic and manual checks in their controllers (`routes → controllers → lib`).
- Expansion domains (milestones, settlements, payout account, contract list, conversations,
  portfolio/careers, recommendations, notification preferences) use
  `routes → controllers → services → lib` with zod schemas in `src/schemas/`.
- Do not add zod `validate()`, a service layer, or `requireActiveUser` to the pre-existing controllers (auth, users, projects, applications, contracts, payments, reviews, notifications).
- Why: the `it.fails` pins depend on the old behavior — e.g. D12 in `test/soft-delete.test.ts`
  (`mutations`): a soft-deleted user can still write on old routes. Guarding one makes the pin
  pass unexpectedly and fails the suite. Fixing a divergence is a separate task (`fix-divergence` skill).

## New route recipe (expansion style)

- Chain: `authenticate → requireActiveUser → requireRole(...) → validate({ body|query|params }) → controller`.
  Attach guards **per route**, never `router.use` (unmatched paths must still fall through — Q10).
- `validate()` puts parsed values in `req.body`, `res.locals.query`, `res.locals.params`. On multipart
  routes mount it **after** `attachmentUpload` / `imageUpload`.
- Controller is thin: call the service, `res.json(...)`, `catch (err) { next(err) }`.
- Business logic, transactions and `AppError`s go in `src/services/<domain>.service.ts`.
- Register every new mutating route in `guardedMutations` (`test/soft-delete.test.ts`) and
  `PROTECTED_ROUTES` (`test/authorization.test.ts`). Full steps: `add-endpoint` skill.

## Mount order (`src/index.ts`)

- `/api/users`: `userRoutes` then `profileRoutes`; `/api/projects`: `projectRoutes` then
  `applicationRoutes`. First router wins on overlapping paths (`/me/*`, `/:id`). Never reorder;
  new `/api/users/me/<x>` routes go in `profile.routes.ts`.
- Inside a router, literal segments before params (`/summary` before `/:id`,
  `PUT /me/portfolio/order` before `/me/portfolio/:itemId`).
- `import 'dotenv/config'` stays the first import of `index.ts`.

## Errors

- `throw new AppError(message, statusCode)` (`lib/errors.ts`); forward with `next(err)`.
  Never `res.status(4xx).json(...)` from a controller.
- `errorHandler` keeps all four parameters (Express detects error handlers by arity).
- Don't annotate handlers `Promise<void>` — handlers `return res.json(...)` mid-function.
- Status rules (BEHAVIOR.md rule 8): malformed input → 400, unique collision → 409,
  provider failure → 502/400 — never 500.

## req.user

- Typed non-optional (`src/types/index.ts`) but `undefined` on the 12 public handlers listed there
  (`signup`, `login`, `refresh`, `googleAuth`, `googleCallback`, `getProjects`, `getProjectById`,
  `getUserById`, `getUserReviews`, `getUserPortfolio`, `getUserCareers`, `runJobs`).
  The compiler won't warn; `test/authorization.test.ts` is the compensating control.
- Middleware that runs on every route (`accessLog`) reads it as optional.

## Transactions

- Any change to more than one row is one `prisma.$transaction` (BEHAVIOR.md rule 6). Canonical:
  accepting an application in `applications.controller.ts` (application, sibling rejections,
  contract + default milestone, project close, notifications, conversation + system message).
- A helper used inside and outside a transaction takes `PrismaTransactionClient`
  (`src/types/index.ts`; see `lib/projectLifecycle.ts`).
- Never catch P2002 *inside* an interactive transaction — Postgres has already aborted it. Use
  `createMany({ skipDuplicates: true })` (see `jobs/queue.ts`) or catch outside (D4 fix).
- `lockUserRow(tx, userId)` is the **first** statement when a transaction writes payout account,
  portfolio/careers or notification preferences (race tests depend on it).

## Other

- Types: import shared types from `src/types/index.ts`, env from `src/env.ts`, models/enums/
  `WhereInput` from `@prisma/client`. Don't hand-roll them.
- AI pricing (`analyzeProject`): always normalize the model's JSON before persisting.
- Uploads: old profile image → `middlewares/upload.ts` (can 500, D6); expansion →
  `middlewares/attachmentUpload.ts` (413/400, storage failure 502).
