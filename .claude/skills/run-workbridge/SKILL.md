---
name: run-workbridge
description: Build, launch, and drive the WorkBridge app locally — both the Express/Prisma backend (:4000) and the Next.js frontend (:3000). Use when asked to run, start, boot, serve, smoke-test, E2E-test, or screenshot WorkBridge (the freelancer-matching platform / 프리랜서 매칭 플랫폼).
---

# Run WorkBridge

Two packages, one product: `workbridge-server` (Express + Prisma, **:4000**) and
`workbridge-client` (Next.js 14, **:3000**). The browser only talks to :3000 — the route handlers
`src/app/api/[...path]` and `src/app/api/auth/*` forward `/api/*` to :4000.

Three ways to check it, cheapest first:
1. `bash .claude/skills/run-workbridge/drive.sh` — API smoke (health, list, seed login, proxy).
2. `node workbridge-client/scripts/screenshots.mjs` — Playwright screenshots of key pages.
3. `bash scripts/e2e.sh` (repo root) — Playwright E2E specs in `workbridge-client/e2e/`.

All paths are relative to the repo root.

## Prerequisites

- Node ≥ 18, npm. PostgreSQL on **localhost** (`brew services start postgresql@14`; superuser =
  your macOS user, no password).
- Playwright's Chromium for 2 and 3: `(cd workbridge-client && npx playwright install chromium)`.
- External services (Google OAuth, OpenAI, TossPayments, Supabase Storage) use dummy values:
  those features fail, every core flow works against the local DB.

## Setup (one-time)

`.env` files are deny-listed for Claude's file tools (`.claude/settings.json`). If writing them
is refused, show these blocks to the user and let them create the files.
Use `localhost` for every URL — any command containing `supabase.co` is denied, because that is
where the real preview/production databases live.

```bash
createdb workbridge 2>/dev/null || echo "db exists (ok)"

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
SUPABASE_URL=http://localhost:54321
SUPABASE_SECRET_KEY=sb_secret_dummy
TRUST_PROXY=loopback
RATE_LIMIT_ENABLED=false
MAIL_PROVIDER=log
EOF

cat > workbridge-client/.env.local <<'EOF'
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_TOSS_CLIENT_KEY=test_ck_dummy
NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true
EOF

(cd workbridge-server && npm install)   # postinstall runs prisma generate
(cd workbridge-client && npm install)
(cd workbridge-server && npx prisma migrate deploy && npm run db:seed)
```

`RATE_LIMIT_ENABLED=false` because every local login comes from loopback and shares one
20-per-15-min budget (BEHAVIOR.md rule 10). Seed: 8 users, 16 projects, 6 contracts covering every
milestone/settlement/conversation state, dates relative to now. **Password for all seed accounts
is `password123`** (`kim@example.com` CLIENT, `park@example.com` FREELANCER; who to use per
screen: `docs/SEED_DATA.md`).

## Run

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

## Drive

1. **API smoke** — `bash .claude/skills/run-workbridge/drive.sh` → expect `== 4 passed, 0 failed ==`.
   Other ports: `API_PORT=4001 CLIENT_PORT=3001 bash .claude/skills/run-workbridge/drive.sh`.
2. **Screenshots** — `node workbridge-client/scripts/screenshots.mjs` (read its header for the page
   list, output directory and options). It warms each route first (a fresh `next dev` compiles on
   first hit) and waits for client-side fetches. A non-empty PNG proves nothing: **open the images
   and look** — a blank frame or error overlay means the page did not hydrate.
3. **E2E** — `bash scripts/e2e.sh` from the repo root runs the Playwright specs in
   `workbridge-client/e2e/`. Specs select by visible Korean text, so a wording change in the
   client must update the spec in the same change.

For an ad-hoc look at one screen, the Playwright MCP server (`.mcp.json`) drives a real browser.

Quick manual checks: `curl -s http://localhost:4000/health` → `{"status":"ok"}`;
`curl -s http://localhost:3000/api/projects | head -c 200` → proxied JSON.

Non-default ports: server `.env` `PORT=4001`, `CLIENT_URL=http://localhost:3001`; client
`.env.local` `API_URL`/`NEXT_PUBLIC_API_URL=http://localhost:4001`; start with `npx next dev -p 3001`.

## Gotchas

- **Seed dates drift.** Projects close on list-read once their deadline passes
  (`lib/projectLifecycle.ts`). Re-seed: `(cd workbridge-server && npm run db:seed)` — plain
  `node prisma/seed.js` does not load `.env`.
- **Payment bypass is ON** locally (both flags). Payments are per milestone:
  `POST /api/payments/dev-complete` takes `{ milestoneId }`, funded in sequence order.
- **Uploads need a storage stub.** `SUPABASE_URL=http://localhost:54321` points at nothing until you run:
  `node -e "require('http').createServer((q,r)=>{q.resume();q.on('end',()=>{r.writeHead(200,{'content-type':'application/json'});r.end('{\"Key\":\"stub\"}')})}).listen(54321)" &`
  Without it, milestone attachments answer 502. Stored URLs point at the stub and don't render.
- **Email is log-only**: `grep mail.sent /tmp/wb-server.log` (dev worker sends within ~5 s).
- **Jobs on a future clock.** Weekly settlement is Monday 03:00 KST, payout Wednesday 10:00 KST,
  unread digest 10 min after a message. To see them now, call
  `runDueJobs({ now: <future>, types: ['settlement.weeklyBatch', 'settlement.payout'] })` from a
  `tsx` one-off inside `workbridge-server/`, twice (the first pass enqueues the next). Always limit
  `types`, or the lifecycle sweep closes every project whose deadline precedes that date.

## Troubleshooting

- `P1001` can't reach database → Postgres not running, or wrong DB in `DATABASE_URL`.
- `@prisma/client did not initialize yet` → `(cd workbridge-server && npm run db:generate)`.
- `relation "Project" does not exist` → `(cd workbridge-server && npx prisma migrate deploy)`.
- `EADDRINUSE` → `lsof -ti:4000 -ti:3000 | xargs kill`.
- 429 on login → set `RATE_LIMIT_ENABLED=false` and restart, or
  `psql -d workbridge -c 'DELETE FROM "RateLimitCounter"'`.
- CORS error → `CLIENT_URL` must be `http://localhost:3000`.
