# CLAUDE.md

WorkBridge (프리랜서 매칭 플랫폼) connects clients (`CLIENT`) with freelancers (`FREELANCER`):
project discovery → application → contract → milestone payments (TossPayments) → settlement →
mutual review, plus messaging, portfolios and AI pricing analysis (OpenAI `gpt-4o-mini`).

Two independent npm packages (no workspace tool — run every command inside the package):
- `workbridge-server/` — Express + Prisma + PostgreSQL API, **TypeScript**, deployed to Vercel.
- `workbridge-client/` — Next.js 14 App Router, **JSX (not TS)**, Tailwind, Zustand.

Docs in `docs/` are Korean. **`docs/BEHAVIOR.md` (English) is the spec and the test oracle.**
Where code disagrees with it, the row is listed under "Known divergences" (D3, D5, …) and pinned
with `it.fails` — current behavior is not the spec. Also: `docs/API.md`, `docs/DATABASE.md`,
`docs/ENV.md`, `docs/DEPLOYMENT.md`, `docs/HARNESS.md` (this harness), `REVIEW.md` (review criteria).

## Commands

Server (`workbridge-server/`):
```bash
npm run dev                          # tsx watch, http://localhost:4000
npm run typecheck                    # tsc --noEmit over src/ and test/
bash scripts/test-db.sh              # create + migrate local workbridge_test (prints its URL)
npm test                             # vitest against that real Postgres (~90 s); TRUNCATEs every table
npx vitest run test/<file>.test.ts   # one file
npx prisma migrate dev --name <name> # new migration; then npm run db:generate
npm run db:seed                      # seed data (docs/SEED_DATA.md)
```

Client (`workbridge-client/`):
```bash
npm run dev     # http://localhost:3000 (proxies /api/* to :4000)
npm run lint    # next lint
npm run build   # the client's correctness check — it has no unit tests
```
E2E from the repo root: `bash scripts/e2e.sh` (Playwright, `workbridge-client/e2e/`).
To boot and drive the whole app use the `run-workbridge` skill.

## Architecture

- Server: `src/index.ts` mounts routers under `/api/*` and `export default app` (Vercel).
  Original domains are `routes → controllers → lib`; expansion domains (milestones, settlements,
  payout account, contract list, conversations, portfolio/careers, recommendations,
  notification preferences) add `services/` and zod `schemas/`. The mix is intentional.
- Domain rules live in `src/lib/` (`money.ts`, `time.ts`, `locks.ts`, `projectLifecycle.ts`,
  `notifications/`), background work in `src/jobs/` (Postgres `Job` table).
- Errors: controllers `throw new AppError(message, status)` and `next(err)`; the global
  `errorHandler` renders `{ error: { message } }`.
- Data: `User → Project → Application → Contract → Milestone/Payment → Review`.
  `User` and `Project` are soft-deleted (`deletedAt`) — filter `deletedAt: null` everywhere.
- Client: all backend calls go through `src/lib/api.js` (Axios + silent token refresh).

Path-scoped details load from `.claude/rules/` when you touch the matching files.

## 함정 (things that bite immediately)

- `import 'dotenv/config'` **must stay the first import** in `src/index.ts`; several modules
  read `process.env` at module-evaluation time.
- Router mount order is load-bearing: `users.routes` before `profile.routes` on `/api/users`,
  `projects.routes` before `applications.routes` on `/api/projects`. First router wins. Add new
  `/api/users/me/<x>` routes to `profile.routes.ts`; never reorder.
- `GET /api/projects` and `GET /api/projects/:id` **write rows** (lazy lifecycle sweep closes
  expired projects). They are not read-only.
- `req.user` is typed non-optional but is `undefined` on the 12 public handlers listed in
  `src/types/index.ts` (incl. `runJobs`, guarded by `X-Internal-Token`). Never read it there.
- Don't annotate handlers `Promise<void>` — many `return res.json(...)` mid-function.
- Multi-row state changes use one `prisma.$transaction`; notifications and jobs are written
  inside it.
- Applied migrations are immutable (a hook blocks edits). Change the schema, then
  `prisma migrate dev`.
- Use `lib/logger.ts`, never `console.*`; `error` level is only for 500s and job failures.
- Email is log-only (`mail.sent` lines). Payment bypass flags must stay `false` in production.
- Production has no job worker: auto-approval, settlements and email run only via
  `POST /api/internal/jobs/run` / `npm run jobs:run`.
