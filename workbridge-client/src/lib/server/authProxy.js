import { NextResponse } from 'next/server';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

export function getApiUrl() {
  return (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
}

// Response headers the browser needs from the backend besides content-type: the request id
// for support/debugging, and Retry-After on a 429.
const PASSTHROUGH_RESPONSE_HEADERS = ['x-request-id', 'retry-after'];

/**
 * Headers every proxied request carries: content-type, authorization, X-Forwarded-For,
 * X-Request-Id.
 *
 * `X-Forwarded-For` is passed on **exactly as Next received it**. Self-hosted Next cannot see
 * the browser's socket address in a route handler (`request.ip` is always undefined); its server
 * only fills the header with the socket address when the client sent none, and on Vercel the
 * edge overwrites it. So a client talking to a self-hosted Next directly can choose this value
 * — the backend trusts it only under `TRUST_PROXY` (BEHAVIOR.md rule 10, Q23).
 */
export function buildForwardHeaders(request) {
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  const authorization = request.headers.get('authorization');
  const requestId = request.headers.get('x-request-id');
  const chain = request.headers.get('x-forwarded-for');

  if (contentType) headers.set('content-type', contentType);
  if (authorization) headers.set('authorization', authorization);
  if (requestId) headers.set('x-request-id', requestId);
  if (chain) headers.set('x-forwarded-for', chain);

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

function getRefreshTokenFromSetCookie(setCookie) {
  if (!setCookie) return null;

  const match = setCookie.match(/(?:^|,\s*)refreshToken=([^;]*)/);
  return match?.[1] || null;
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
  const refreshToken = getRefreshTokenFromSetCookie(backendResponse.headers.get('set-cookie'));

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

export async function proxyGoogleRedirect(request, path) {
  const backendResponse = await fetch(`${getApiUrl()}/api/auth/${path}${request.nextUrl.search}`, {
    method: 'GET',
    redirect: 'manual',
  });

  const location = backendResponse.headers.get('location') || '/login?error=oauth_failed';
  const redirectStatus = [301, 302, 303, 307, 308].includes(backendResponse.status)
    ? backendResponse.status
    : 302;
  const response = NextResponse.redirect(new URL(location, request.nextUrl.origin), redirectStatus);
  setRefreshTokenCookie(response, backendResponse);

  return response;
}
