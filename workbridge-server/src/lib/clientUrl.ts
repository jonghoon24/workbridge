import { env } from '../env';

/**
 * The frontend's address, from `CLIENT_URL`, for everything that sends a browser there: the Google
 * login redirects, the links in emails, and the CORS allow-list. What fails without it: `.env.example`.
 *
 * `CLIENT_URL` is **one origin** (`https://app.example.com`, a trailing `/` is fine). Extra CORS
 * origins go in `CORS_ORIGINS`, never here. A missing or malformed value does not stop the server
 * from booting (`env.ts` reads lazily, and most routes never need it); the code paths that need it
 * fail clearly instead — see `clientUrl()` and `readClientUrl()`.
 */

export type ClientUrlResult = { ok: true; origin: string } | { ok: false; error: string };

export const CLIENT_URL_MISSING = 'CLIENT_URL is not set';
export const CLIENT_URL_INVALID =
  'CLIENT_URL must be a single origin such as https://app.example.com; put additional CORS origins in CORS_ORIGINS';

/** `CLIENT_URL` read now, as an origin without a trailing `/`, or why it cannot be used. */
export function readClientUrl(): ClientUrlResult {
  const raw = (env.CLIENT_URL ?? '').trim();
  if (!raw) return { ok: false, error: CLIENT_URL_MISSING };
  // A comma or space means a list, which `new URL` would otherwise read as one odd path.
  if (/[\s,]/.test(raw)) return { ok: false, error: CLIENT_URL_INVALID };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: CLIENT_URL_INVALID };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: CLIENT_URL_INVALID };
  // Only an origin: no path, query or fragment beyond a trailing `/`. Scheme and host are
  // case-insensitive, and `url.origin` is lowercase.
  if (url.origin !== raw.replace(/\/+$/, '').toLowerCase()) return { ok: false, error: CLIENT_URL_INVALID };

  return { ok: true, origin: url.origin };
}

/** The frontend origin. Throws when `CLIENT_URL` is unusable — an error the request answers with a 500. */
export function clientUrl(): string {
  const result = readClientUrl();
  if (!result.ok) throw new Error(result.error);
  return result.origin;
}

const DEV_ORIGIN = 'http://localhost:3000';

/** `CORS_ORIGINS` as a list: comma separated, trimmed, without a trailing `/`. */
function extraCorsOrigins(): string[] {
  return (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * The browser origins CORS allows: `CLIENT_URL` (when usable), every `CORS_ORIGINS` entry, and in
 * development `http://localhost:3000`. `problem` is why `CLIENT_URL` was left out, for a boot warning.
 */
export function corsOrigins(): { origins: Set<string>; problem: string | null } {
  const client = readClientUrl();
  return {
    origins: new Set([
      ...(client.ok ? [client.origin] : []),
      ...extraCorsOrigins(),
      ...(!env.isProduction ? [DEV_ORIGIN] : []),
    ]),
    problem: client.ok ? null : client.error,
  };
}
