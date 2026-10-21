---
name: run-workbridge
description: Build, launch, and drive the WorkBridge app locally — both the Express/Prisma backend (:4000) and the Next.js frontend (:3000). Use when asked to run, start, boot, serve, smoke-test, or screenshot WorkBridge (the freelancer-matching platform / 프리랜서 매칭 플랫폼).
---

# Run WorkBridge

WorkBridge is a two-package web app that runs as one product: `workbridge-server`
(Express + Prisma API on **:4000**) and `workbridge-client` (Next.js 14 App Router
on **:3000**). The browser talks to the API **same-origin** — the Next.js dev server
proxies `/api/*` to :4000, so you only ever visit :3000.

Drive it with **`.claude/skills/run-workbridge/drive.sh`**: it runs API smoke tests,
a real seed-account login, and captures headless-Chrome screenshots of the frontend.

All paths below are relative to the repo root. Verified on macOS (darwin) with a
Homebrew Postgres. Commands were run this session and passed.

## Prerequisites

- **Node** ≥ 18 (verified on v22), npm.
- **PostgreSQL running locally.** Homebrew: `brew services start postgresql@14`.
  The default superuser is your macOS username with no password — that's what the
  setup below uses.
- **Google Chrome** (for screenshots), at
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Optional — the
  API smoke tests still run without it.

External services (Google OAuth, OpenAI pricing analysis, TossPayments, Supabase
image upload) are **stubbed with dummy keys** — those features won't work, but every
core flow (auth, projects, applications, contracts, reviews) runs against the local DB.

## Setup (one-time)

```bash
# 1. Local database
createdb workbridge 2>/dev/null || echo "db exists (ok)"

# 2. Server env (.env) — local DB + dummy external-service keys, payment bypass ON
cat > workbridge-server/.env <<EOF
PORT=4000
DATABASE_URL=postgresql://$(whoami)@localhost:5432/workbridge
DIRECT_URL=postgresql://$(whoami)@localhost:5432/workbridge
JWT_ACCESS_SECRET=local_dev_access_secret_change_me
JWT_REFRESH_SECRET=local_dev_refresh_secret_change_me
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
GOOGLE_CLIENT_ID=dummy
GOOGLE_CLIENT_SECRET=dummy
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
OPENAI_API_KEY=dummy
TOSS_SECRET_KEY=test_sk_dummy
ALLOW_PAYMENT_BYPASS=true
CLIENT_URL=http://localhost:3000
SUPABASE_URL=https://dummy.supabase.co
SUPABASE_SECRET_KEY=sb_secret_dummy
TRUST_PROXY=loopback
# Every local login comes from loopback and would share one 20-per-15-min login limit.
RATE_LIMIT_ENABLED=false
EOF

# 3. Client env (.env.local)
cat > workbridge-client/.env.local <<'EOF'
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_TOSS_CLIENT_KEY=test_ck_dummy
NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true
EOF

# 4. Install deps (server postinstall runs `prisma generate`)
(cd workbridge-server && npm install)
(cd workbridge-client && npm install)

# 5. Apply migrations + seed
(cd workbridge-server && npx prisma migrate deploy && npm run db:seed)
```

Seed creates 8 users / 8 projects / contracts / payments / reviews. **All seed
account passwords are `password123`** (e.g. `kim@example.com` = CLIENT,
`park@example.com` = FREELANCER; see `docs/SEED_DATA.md`).

## Run

Launch both dev servers in the background, then wait for them to report ready:

```bash
(cd workbridge-server && npm run dev > /tmp/wb-server.log 2>&1 &)
(cd workbridge-client && npm run dev > /tmp/wb-client.log 2>&1 &)

for i in $(seq 1 30); do
  grep -q "Server running on port" /tmp/wb-server.log 2>/dev/null \
    && grep -qE "Ready in|Local:" /tmp/wb-client.log 2>/dev/null && break
  sleep 1
done
tail -n2 /tmp/wb-server.log /tmp/wb-client.log
```

Backend logs to `/tmp/wb-server.log`, frontend to `/tmp/wb-client.log`.

## Drive (agent path)

With both servers up, run the driver — API smoke + login + screenshots:

```bash
bash .claude/skills/run-workbridge/drive.sh /tmp/wb-shots
```

Expected tail: `== 6 passed, 0 failed ==` (exit 0). Screenshots land in `/tmp/wb-shots/`
(`home.png`, `projects.png`) — **open them and look**; a blank frame or error page
means the frontend didn't hydrate. `home.png` shows the hero + feature cards + a
recent-project card; `projects.png` shows the filter sidebar and project listing.

Quick manual checks:

```bash
curl -s http://localhost:4000/health                        # {"status":"ok"}
curl -s http://localhost:3000/api/projects | head -c 200     # proxied list JSON
```

## Human path

Same two `npm run dev` commands in the foreground (two terminals), then open
http://localhost:3000 and sign in with a seed account. `Ctrl-C` to stop each.

## Gotchas

- **Only ~1 project shows as OPEN, not 8.** Not a bug. `lib/projectLifecycle.js`
  auto-closes projects whose seeded deadlines have passed (seed dates are static and
  now in the past), flipping them to CLOSED on list-read. Sign in to see fuller data,
  or re-seed to refresh dates: `(cd workbridge-server && npm run db:seed)`.
- **Frontend fetches data client-side.** A naive screenshot can fire before the
  fetch settles — `drive.sh` passes `--virtual-time-budget=8000` to let JS + network
  finish. Bump it if a page looks empty.
- **`createdb` errors "already exists"** on re-run — harmless; the `|| echo` swallows it.
- **Two servers, two package.json** — there is no root workspace. `npm install` and
  all scripts run *inside* each package dir.
- **Same-origin only in the browser.** The client's API base is `''` (relative), so
  the browser hits `:3000/api/*` and Next.js rewrites to `:4000`. Don't expect the
  browser to call `:4000` directly.
- **Payment bypass is ON** here (`ALLOW_PAYMENT_BYPASS=true` both sides) so the
  contract→payment→review flow works without the Toss sandbox. Keep it `false` in prod.

## Troubleshooting

- **Server exits / Prisma `P1001` can't reach database** → Postgres isn't running
  (`brew services start postgresql@14`) or the DB/user in `DATABASE_URL` is wrong.
  Test directly: `psql "postgresql://$(whoami)@localhost:5432/workbridge" -c '\dt'`.
- **`@prisma/client did not initialize yet`** → run `(cd workbridge-server && npm run db:generate)`.
- **`relation "Project" does not exist`** → migrations not applied:
  `(cd workbridge-server && npx prisma migrate deploy)`.
- **`EADDRINUSE` on 3000/4000** → a previous run is still up:
  `lsof -ti:4000 -ti:3000 | xargs kill`.
- **429 `Too many requests` on login** → the rate limit counts every local login under one
  loopback address. Set `RATE_LIMIT_ENABLED=false` in `workbridge-server/.env` and restart
  the server (dotenv loads `.env` once at boot), or clear the counters without restarting:
  `psql "postgresql://$(whoami)@localhost:5432/workbridge" -c 'DELETE FROM "RateLimitCounter"'`.
- **CORS error in browser** → `CLIENT_URL` in `workbridge-server/.env` must be
  `http://localhost:3000`.
- **Screenshots blank / `drive.sh` browser step skipped** → Chrome not at the
  expected path; API checks still pass. Adjust `CHROME` in `drive.sh`.
