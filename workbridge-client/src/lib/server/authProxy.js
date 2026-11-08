import { NextResponse } from 'next/server';
import { getApiUrl } from '@/lib/apiUrl';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
// Google OAuth `state` (login CSRF defence): the backend issues it on `GET /api/auth/google` and
// checks it on the callback. Same name, path and lifetime as the backend's cookie.
const OAUTH_STATE_COOKIE_NAME = 'oauthState';
const OAUTH_STATE_COOKIE_PATH = '/api/auth/google';
const OAUTH_STATE_COOKIE_MAX_AGE = 10 * 60;

// Response headers the browser needs from the backend besides content-type: the request id
// for support/debugging, and Retry-After on a 429.
const PASSTHROUGH_RESPONSE_HEADERS = ['x-request-id', 'retry-after'];

/**
 * The browser's address as Vercel's edge recorded it, or null off Vercel. The edge overwrites
 * `X-Vercel-Forwarded-For` (and `X-Forwarded-For`) with the address that connected to it, so a
 * browser cannot choose this value there. Self-hosted Next has no such guarantee — there the
 * header is whatever the client sent — so the value is only read on Vercel (`VERCEL=1`).
 */
function vercelClientIp(request) {
  if (process.env.VERCEL !== '1') return null;
  return request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || null;
}

/**
 * Headers every proxied request carries: content-type, authorization, X-Forwarded-For,
 * X-Request-Id, and on Vercel the browser's address.
 *
 * The backend sees this function, not the browser: Vercel's edge in front of the backend rewrites
 * `X-Forwarded-For` to this function's own address. So when `PROXY_SHARED_SECRET` is set (the same
 * value as the backend's), the browser's address goes in `X-Client-IP` with the secret in
 * `X-Proxy-Secret`, and the backend trusts `X-Client-IP` only when the secret matches
 * (BEHAVIOR.md rule 10, `workbridge-server/src/lib/clientIp.ts`).
 *
 * `X-Forwarded-For` is still passed on exactly as Next received it, for self-hosted setups where
 * the backend runs with `TRUST_PROXY` (Q23).
 */
export function buildForwardHeaders(request) {
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  const authorization = request.headers.get('authorization');
  const requestId = request.headers.get('x-request-id');
  const chain = request.headers.get('x-forwarded-for');
  const proxySecret = process.env.PROXY_SHARED_SECRET;
  const clientIp = proxySecret ? vercelClientIp(request) : null;

  if (contentType) headers.set('content-type', contentType);
  if (authorization) headers.set('authorization', authorization);
  if (requestId) headers.set('x-request-id', requestId);
  if (chain) headers.set('x-forwarded-for', chain);
  if (clientIp) {
    headers.set('x-client-ip', clientIp);
    headers.set('x-proxy-secret', proxySecret);
  }

  return headers;
}

/** Response headers for the browser: content-type plus the passthrough list above. */
export function buildResponseHeaders(backendResponse) {
  const headers = {
    'content-type': backendResponse.headers.get('content-type') || 'application/json',
  };

  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = backendResponse.headers.get(name);
    if (value) headers[name] = value;
  }

  return headers;
}

/** The value of cookie `name` among the backend's `Set-Cookie` headers, or null. */
function getCookieFromSetCookie(backendResponse, name) {
  const cookies = typeof backendResponse.headers.getSetCookie === 'function'
    ? backendResponse.headers.getSetCookie()
    : [backendResponse.headers.get('set-cookie') || ''];
  const prefix = `${name}=`;

  for (const cookie of cookies) {
    // A joined header (older runtimes) separates cookies with ", ".
    for (const part of cookie.split(/,\s*(?=[^;=\s]+=)/)) {
      if (part.startsWith(prefix)) return part.slice(prefix.length).split(';')[0] || null;
    }
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function setRefreshTokenCookie(response, backendResponse) {
  const refreshToken = getCookieFromSetCookie(backendResponse, REFRESH_COOKIE_NAME);

  if (!refreshToken) return;

  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    maxAge: REFRESH_COOKIE_MAX_AGE,
    ...cookieOptions(),
  });
}

export function clearRefreshTokenCookie(response) {
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: '',
    maxAge: 0,
    ...cookieOptions(),
  });
}

export async function proxyAuthRequest(request, path, options = {}) {
  const headers = buildForwardHeaders(request);
  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;

  if (refreshToken) headers.set('cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

  const init = {
    method: options.method || request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(init.method)) {
    const body = await request.text();
    if (body) init.body = body;
  }

  const backendResponse = await fetch(`${getApiUrl()}/api/auth/${path}`, init);
  const body = await backendResponse.text();
  const response = new NextResponse(body, {
    status: backendResponse.status,
    headers: buildResponseHeaders(backendResponse),
  });

  setRefreshTokenCookie(response, backendResponse);

  return response;
}

function setOAuthStateCookie(response, value, maxAge) {
  response.cookies.set({
    name: OAUTH_STATE_COOKIE_NAME,
    value,
    maxAge,
    ...cookieOptions(),
    path: OAUTH_STATE_COOKIE_PATH,
  });
}

/**
 * `GET /api/auth/google` and its callback. The backend's redirect is replayed to the browser, and
 * the cookies the backend set on this server-to-server hop are moved onto the browser's origin:
 * the OAuth `state` cookie on the way out, the refresh cookie on the way back. The callback
 * forwards the browser's `state` cookie to the backend, which compares it with the `state`
 * Google echoed, and then the browser's copy is cleared — one state per attempt.
 */
export async function proxyGoogleRedirect(request, path) {
  const isCallback = path === 'google/callback';
  const headers = new Headers();
  const state = request.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;
  if (isCallback && state) headers.set('cookie', `${OAUTH_STATE_COOKIE_NAME}=${state}`);

  const backendResponse = await fetch(`${getApiUrl()}/api/auth/${path}${request.nextUrl.search}`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });

  const location = backendResponse.headers.get('location') || '/login?error=oauth_failed';
  const redirectStatus = [301, 302, 303, 307, 308].includes(backendResponse.status)
    ? backendResponse.status
    : 302;
  const response = NextResponse.redirect(new URL(location, request.nextUrl.origin), redirectStatus);

  if (isCallback) {
    setOAuthStateCookie(response, '', 0);
    setRefreshTokenCookie(response, backendResponse);
  } else {
    const issuedState = getCookieFromSetCookie(backendResponse, OAUTH_STATE_COOKIE_NAME);
    if (issuedState) setOAuthStateCookie(response, issuedState, OAUTH_STATE_COOKIE_MAX_AGE);
  }

  return response;
}
