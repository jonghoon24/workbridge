/**
 * Backend base URL for server-side code (Next route handlers and SSR). Never call it from
 * browser code: the browser talks to same-origin `/api/*` instead. `src/lib/api.js` imports this
 * module in browser bundles too, so `@vercel/related-projects` is required lazily behind a
 * `typeof window` check that Next compiles away in client builds; a static import would ship the
 * package (and the `VERCEL_RELATED_PROJECTS` name) to the browser.
 *
 * Priority:
 *   1. `API_URL` — explicit server-only override.
 *   2. Vercel Related Projects (`vercel.json` `relatedProjects`), only when Vercel set
 *      `VERCEL_RELATED_PROJECTS`: the `workbridge-server` host for the current environment
 *      (on a preview, the server preview of the same branch).
 *   3. `NEXT_PUBLIC_API_URL`.
 *   4. `http://localhost:4000`.
 * A bare host gets `https://`; a trailing `/` is removed.
 *
 * Why Related Projects: Vercel truncates long branch slugs and appends a hash that differs per
 * project, so the server's branch URL cannot be derived from the client's branch name.
 */
export function getApiUrl() {
  const url = resolveApiUrl();
  const withProtocol = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProtocol.replace(/\/$/, '');
}

function resolveApiUrl() {
  if (process.env.API_URL) return process.env.API_URL;

  if (typeof window === 'undefined' && process.env.VERCEL_RELATED_PROJECTS) {
    const { withRelatedProject } = require('@vercel/related-projects');
    const host = withRelatedProject({
      projectName: 'workbridge-server',
      defaultHost: process.env.NEXT_PUBLIC_API_URL,
    });
    if (host) return host;
  }

  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}
