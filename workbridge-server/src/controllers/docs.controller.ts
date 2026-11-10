import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { buildOpenApiDocument } from '../openapi/document';

/**
 * `GET /api/docs` and `GET /api/openapi.json` — the API reference. Public, so these never read
 * `req.user`.
 *
 * On only where it is known to be safe (an allowlist, so a misconfigured deployment fails closed):
 * a Vercel `preview` or `development` deployment, or — with no `VERCEL_ENV` at all — a process
 * whose `NODE_ENV` is not `production` (local and test). Everywhere else (`VERCEL_ENV=production`,
 * an unknown `VERCEL_ENV`, or no `VERCEL_ENV` with `NODE_ENV=production`) it is off: the document
 * lists internal endpoints and every error message, which is more than the public site needs.
 * There the request leaves the router and ends like an unmatched path — Express's HTML 404 — so
 * the routes do not reveal they exist. Read per request, like the other flags.
 */
const DOCS_VERCEL_ENVS = new Set(['preview', 'development']);

function docsEnabled(): boolean {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv) return DOCS_VERCEL_ENVS.has(vercelEnv);
  return env.NODE_ENV !== 'production';
}

export function requireDocsEnabled(_req: Request, _res: Response, next: NextFunction) {
  if (!docsEnabled()) {
    return next('router');
  }
  next();
}

/** Built on first use; the document depends on the code only. */
let document: ReturnType<typeof buildOpenApiDocument> | undefined;

export function getOpenApiDocument(_req: Request, res: Response, next: NextFunction) {
  try {
    document ??= buildOpenApiDocument();
    res.json(document);
  } catch (err) {
    next(err);
  }
}

/**
 * Scalar API Reference from jsDelivr, pinned to an exact version with Subresource Integrity, so a
 * changed or compromised CDN file is refused by the browser. To upgrade, change the version and
 * recompute the hash: `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
const SCALAR_SRC = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js';
const SCALAR_INTEGRITY = 'sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ';

const DOCS_PAGE = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WorkBridge API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_SRC}" integrity="${SCALAR_INTEGRITY}" crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/api/openapi.json' });
    </script>
  </body>
</html>
`;

export function getDocsPage(_req: Request, res: Response) {
  res.type('html').send(DOCS_PAGE);
}
