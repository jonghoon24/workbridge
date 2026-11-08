import { clearRefreshTokenCookie, proxyAuthRequest } from '@/lib/server/authProxy';

export async function POST(request) {
  const response = await proxyAuthRequest(request, 'refresh');
  // A refresh the backend refuses (expired, wrong secret, user gone — e.g. after a seed reset)
  // will never succeed, so drop the cookie. Otherwise `middleware.js` keeps bouncing `/login`
  // to `/` because the cookie still exists, and the user cannot reach the login page.
  if (response.status === 401) clearRefreshTokenCookie(response);
  return response;
}
