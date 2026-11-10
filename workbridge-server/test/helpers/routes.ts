import type { Express } from 'express';

interface RouterLayer {
  name: string;
  regexp: RegExp & { fast_slash?: boolean };
  keys: unknown[];
  route?: { path: unknown; methods: Record<string, boolean> };
  handle: { stack?: RouterLayer[] };
}

/** The literal prefix an `app.use(path, router)` layer matches (Express 4 compiles it to a regexp). */
function mountPathOf(layer: RouterLayer): string {
  if (layer.regexp.fast_slash) return '';
  const path = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
  if (layer.keys.length > 0 || /[\\^$()[\]{}*+?|]/.test(path)) {
    throw new Error(`cannot read a literal mount path from ${layer.regexp}`);
  }
  return path;
}

/**
 * Every route the app serves as `{ method, path }` (Express syntax, `/:id`), read from its router
 * stack with nested routers included. The same walk as `test/authorization.test.ts`.
 */
export function mountedRoutes(app: Express): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  const walk = (stack: RouterLayer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        if (typeof path !== 'string') throw new Error(`non-string route path under ${prefix}`);
        for (const method of Object.keys(methods)) {
          routes.push({ method: method.toUpperCase(), path: `${prefix}${path === '/' && prefix ? '' : path}` });
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPathOf(layer));
      }
    }
  };
  walk((app as unknown as { _router: { stack: RouterLayer[] } })._router.stack, '');
  return routes;
}
