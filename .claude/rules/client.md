---
paths:
  - "workbridge-client/**"
---

# Client (Next.js 14 App Router, JSX)

- **JSX, not TypeScript.** Don't add `.ts/.tsx` files or TS config.
- **Backend calls go through `src/lib/api.js`** (single Axios instance). Its interceptor attaches the
  access token, refreshes once on 401 via `/api/auth/refresh`, queues concurrent failures, retries,
  and redirects to `/login` when refresh fails. No raw `axios`/`fetch` in components.
  Exception: `src/lib/authApi.js` (login, signup, select-role, logout) — no refresh interceptor,
  so a failed login doesn't trigger a refresh loop.
- **Base URL split:** in the browser `getBaseURL()` is `''` (same-origin `/api/*`, forwarded by the
  route handlers `src/app/api/[...path]/route.js` and `src/app/api/auth/*`); during SSR it is
  `API_URL || NEXT_PUBLIC_API_URL`. New HTTP methods must be exported from the catch-all route.
- **`src/middleware.js` is cookie-presence gating**, not verification: no `refreshToken` cookie on a
  `protectedRoutes` path → `/login?redirect=…`. Adding a protected page means adding its prefix
  there. The server's controllers remain the real authorization boundary.
- Auth state: `src/store/authStore.js` (Zustand) mirrors `accessToken`/`user` into `localStorage`;
  call `initAuth()` on load. List filters/pagination: `src/store/projectStore.js`.
- **Keep user-visible Korean wording stable.** E2E tests select by text; changing a label or
  message breaks them. If you must change it, update `workbridge-client/e2e/` in the same change.
- Payment bypass button depends on `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` — `false` in production.
- **Checks** (no unit tests): `npm run lint`, `npm run build`; then
  E2E `bash scripts/e2e.sh` from the repo root (Playwright specs in `workbridge-client/e2e/`) and
  screenshots with `node workbridge-client/scripts/screenshots.mjs` — open the PNGs and look.
  The Playwright MCP server (`.mcp.json`) can drive a real browser for ad-hoc checks.
