import { isIP } from 'node:net';
import type { Request } from 'express';

import { env } from '../env';
import { safeEqual } from './safeEqual';

/** The browser's address, as the Next.js proxy saw it. Trusted only with the shared secret. */
export const CLIENT_IP_HEADER = 'x-client-ip';
/** Carries `PROXY_SHARED_SECRET` from the Next.js proxy. */
export const PROXY_SECRET_HEADER = 'x-proxy-secret';
/** Vercel's edge overwrites this with the address that connected to it. */
const VERCEL_FORWARDED_FOR = 'x-vercel-forwarded-for';

function firstAddress(value: string | undefined): string | null {
  const first = value?.split(',')[0]?.trim();
  return first && isIP(first) ? first : null;
}

/**
 * The client IP — the rate-limit key and the access log's `ip`. In order:
 *
 * 1. `X-Client-IP`, only when `PROXY_SHARED_SECRET` is set and `X-Proxy-Secret` equals it. This is
 *    how the Next.js proxy passes on the browser's address; without the secret anyone could pick
 *    their own rate-limit key with a header.
 * 2. On Vercel (`VERCEL=1`), `X-Vercel-Forwarded-For`: the edge replaces whatever the caller sent
 *    with the address that connected to it — the browser for a direct call, the Next.js
 *    function for a proxied one without the secret.
 * 3. Express's `req.ip`: the socket address, or with `TRUST_PROXY` the address from
 *    `X-Forwarded-For` minus the trusted proxies. On Vercel the socket is always `127.0.0.1`.
 */
export function clientIp(req: Request): string {
  const secret = env.PROXY_SHARED_SECRET;
  if (secret) {
    const provided = req.get(PROXY_SECRET_HEADER);
    const forwarded = firstAddress(req.get(CLIENT_IP_HEADER));
    if (provided && forwarded && safeEqual(provided, secret)) {
      return forwarded;
    }
  }

  if (env.VERCEL === '1') {
    const edge = firstAddress(req.get(VERCEL_FORWARDED_FOR));
    if (edge) return edge;
  }

  return req.ip ?? 'unknown';
}
