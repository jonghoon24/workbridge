import { clearRefreshTokenCookie, proxyAuthRequest } from '@/lib/server/authProxy';

export async function POST(request) {
  const response = await proxyAuthRequest(request, 'logout');
  clearRefreshTokenCookie(response);
  return response;
}
