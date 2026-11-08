---
paths:
  - "workbridge-server/vercel.json"
  - "workbridge-server/src/index.ts"
  - "workbridge-server/src/env.ts"
  - "workbridge-server/package.json"
  - "workbridge-client/next.config.js"
  - "workbridge-client/package.json"
  - ".github/workflows/**"
  - "docs/DEPLOYMENT.md"
  - "docs/ENV.md"
  - "**/.env.example"
---

# Deployment (Vercel)

- `workbridge-server/vercel.json` hardcodes the entry **twice** (`builds[].src` and `routes[].dest`
  = `src/index.ts`). Renaming the entry means changing both.
- `@vercel/node` transpiles TypeScript directly: **no build step, no `dist/`**. The Build Command
  (`npx prisma generate`) lives in the Vercel dashboard, not the repo — avoid changes that would
  require editing it.
- `index.ts` must keep `export default app`; it calls `app.listen()` and starts the dev worker only
  when `NODE_ENV` is neither `production` nor `test`.
- Environments: Vercel **Preview** and **Production** have separate env vars and **separate
  Supabase projects** (separate databases). Never paste either connection string into a command
  (`supabase.co`/`supabase.com` in Bash is denied). Local work uses `localhost` Postgres.
- Migrations reach the remote DBs only through CI: on merge to `main` a workflow job runs
  `prisma migrate deploy` against preview and production. Don't run it by hand.
- **Production has no job worker** (no resident process): only `POST /api/internal/jobs/run`
  (`INTERNAL_JOB_TOKEN`) or `npm run jobs:run`. See `docs/DEPLOYMENT.md` "운영 환경의 한계".
- `ALLOW_PAYMENT_BYPASS` (server) and `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` (client) must be `false`
  in production. `MAIL_PROVIDER=log` writes addresses and full text to logs — dev only.
- New env vars: add to `src/env.ts` (lazy getter), `.env.example`, and `docs/ENV.md`.
- Google OAuth `GOOGLE_CALLBACK_URL` points at the **frontend** (`/api/auth/google/callback`).
