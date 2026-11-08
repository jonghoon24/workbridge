/**
 * Backend base URL for server-side code (Next route handlers and SSR). Never call it from
 * browser code: the browser talks to same-origin `/api/*` instead.
 *
 * Priority:
 *   1. `API_URL` — explicit server-only override.
 *   2. `API_URL_TEMPLATE` with `{branch}` replaced by the slug of `VERCEL_GIT_COMMIT_REF`, only
 *      when both are set. On a Vercel preview this points the client at the server preview
 *      deployed from the same branch.
 *   3. `NEXT_PUBLIC_API_URL`.
 *   4. `http://localhost:4000`.
 * A trailing `/` is removed.
 */
export function getApiUrl() {
  return resolveApiUrl().replace(/\/$/, '');
}

function resolveApiUrl() {
  if (process.env.API_URL) return process.env.API_URL;

  const template = process.env.API_URL_TEMPLATE;
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  if (template && branch) return template.replaceAll('{branch}', branchSlug(branch));

  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}

// Vercel's branch-URL slug: lowercase, non-alphanumerics to `-`, runs collapsed, edges trimmed.
// Vercel also truncates long hostnames and appends a hash; that is not reproduced here, so
// keep branch names short.
function branchSlug(branch) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
