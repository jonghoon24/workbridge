import { NextResponse } from 'next/server';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function getApiUrl() {
  return (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
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
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  const authorization = request.headers.get('authorization');
  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;

  if (contentType) headers.set('content-type', contentType);
  if (authorization) headers.set('authorization', authorization);
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
    headers: {
      'content-type': backendResponse.headers.get('content-type') || 'application/json',
    },
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
