---
name: add-endpoint
description: Add a new API endpoint to workbridge-server the expansion way — spec rules in BEHAVIOR.md, zod schema, service, thin controller, guarded route, matrix rows in the authorization and soft-delete tests, docs/API.md, factory-based tests. Use for any new route; never use it to restyle a pre-existing route.
argument-hint: <METHOD> <path> — <what it does>
---

# Add an endpoint (expansion recipe)

Every new route follows BEHAVIOR.md rule 12. Pre-existing routes (auth, users, projects,
applications, contracts, payments, reviews, notifications) are **not** converted to this style.
Copy from a recent full stack — the notification preferences or portfolio route — rather than
from the old controllers:

| Layer | Example |
|---|---|
| schema | `src/schemas/profile.ts`, `src/schemas/notificationPreferences.ts`, helpers in `schemas/common.ts` (`queryInt`, `queryEnum`, `queryString`), `schemas/pagination.ts` (`pageQuery`) |
| service | `src/services/portfolio.service.ts`, `notificationPreferences.service.ts` |
| controller | `src/controllers/settlements.controller.ts` |
| route | `src/routes/settlements.routes.ts`, `profile.routes.ts` |

## 1. Spec first — `docs/BEHAVIOR.md`

Add the section **after the Notifications section** (rule 12 applies to everything documented
after it). Give the domain a rule prefix (`PF`, `NC`, `MS`, …) and number every rule:
- check order: role (403 `Insufficient permissions`) → upload (413/400) → validation (400
  `<path>: <message>`) → existence (404) → ownership (403 `Not authorized`) → state (409);
- exact messages, the response shape and status (`201 { item }`, `200 { items, meta }`);
- which rows change in one transaction (rule 6), notifications via `notify()`, jobs enqueued;
- soft delete (rule 5): what a deleted project/user makes invisible;
- concurrency: whether the transaction starts with `lockUserRow`, and the race outcome.
Ask the user to confirm any rule you had to invent.

## 2. Schema — `src/schemas/<domain>.ts`

- `z.object({...})` per body/query/params; messages exactly as the spec (`'Title is required'`).
- Money: integer won (`z.number().int()`), constants from `lib/money.ts`.
- Dates: validate `YYYY-MM-DD` / `YYYY-MM` strings and compare via `lib/time.ts` helpers.
- Export the inferred type (`export type XInput = z.infer<typeof xBody>`) for the service.

## 3. Service — `src/services/<domain>.service.ts`

- All logic and every `throw new AppError(message, status)` live here.
- Take `now: Date` as a parameter if anything depends on time; never `new Date()` here.
- Multi-row writes: one `prisma.$transaction(async (tx) => …)`.
  - Per-user writes (payout account, portfolio/careers, preferences): `await lockUserRow(tx, userId)`
    as the **first** statement.
  - Notifications: `notify(tx, {...})` / `notifyMany(tx, …)` inside the transaction.
  - Jobs: `enqueueJob(tx, { type, payload, runAt, dedupeKey })` inside the transaction.
  - Unique collision → 409: catch P2002 **outside** the transaction, or use `skipDuplicates`.
- Reads filter `deletedAt: null` on `User`/`Project` (and through `contract.project`).
- Logging only through `logger` (`warn`/`info`).

## 4. Controller — `src/controllers/<domain>.controller.ts`

```ts
/** `POST /api/<path>` (XX3). */
export async function postThing(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await createThing(req.user.id, req.body as ThingInput, new Date()));
  } catch (err) {
    next(err);
  }
}
```

Parsed query is in `res.locals.query`, params in `res.locals.params` (not `req.query`). No
`Promise<void>` annotation. A public handler must not read `req.user`; add it to the list in
`src/types/index.ts` and to `PUBLIC_ROUTES` in `test/authorization.test.ts`.

## 5. Route

```ts
const guard = [authenticate, requireActiveUser, requireRole('FREELANCER')];
router.post('/things', ...guard, validate({ body: thingBody }), postThing);
// multipart: ...guard, attachmentUpload /* or imageUpload */, validate({ body }), handler
```

- Guards per route, never `router.use` (Q10). Literal paths before `/:id`.
- New `/api/users/me/<x>` routes go in `profile.routes.ts` (mounted after `users.routes.ts`).
- A new router: mount it in `src/index.ts` before `errorHandler`; never reorder existing mounts.

## 6. Matrices (cross-cutting tests — required)

- `test/authorization.test.ts` → add a `RouteSpec` to `PROTECTED_ROUTES`
  (`label`, `method`, `path: (ids) => …`, `body`, `role`, `gate: 'middleware'`); add any new id
  to `Ids`/`MISSING`. Update the route count in the comment above the table.
- `test/soft-delete.test.ts` → for a mutating route add a `Mutation` to **`guardedMutations`**
  (`setup()` returns `{ actor, send(token), assertUnchanged() }`). **Never to `mutations`** (that
  table is `it.fails` D12 for the old routes).
- Don't re-assert 401/403/soft-delete per endpoint elsewhere.

## 7. Endpoint tests — `test/<domain>.test.ts`

- Fixtures per test from `test/helpers/factories.ts`; HTTP via `authed(user)` / `api()`.
- One `describe` per route, test names cite the rule (`'… [XX3]'`). Cover each status in the
  check order, the exact messages, the response shape, rollback on failure, and the race if any.
- Time: pass `now`, drive jobs with `runJobs(now)` / `jobsOf(type)`; no fake timers.
- Uploads: `vi.mock('@supabase/supabase-js', …)` at the top of the file.

## 8. Docs

- `docs/API.md` (Korean): the route under its domain section — fields, response, errors in check
  order, matching the existing bullet style; add the domain to "확장 라우트의 공통 순서" if new.
- New model/column → `db-migration` skill. New env var → `src/env.ts`, `.env.example`, `docs/ENV.md`.
- New domain → add it to the expansion lists in `CLAUDE.md`, `.claude/rules/server-layers.md`
  and `REVIEW.md`.

## 9. Verify

```bash
cd workbridge-server
npm run typecheck
npx vitest run test/<domain>.test.ts test/authorization.test.ts test/soft-delete.test.ts
npm test
```

If the client calls it: use `src/lib/api.js`, then `npm run lint && npm run build` in
`workbridge-client/` and check the screen (`run-workbridge` skill).
