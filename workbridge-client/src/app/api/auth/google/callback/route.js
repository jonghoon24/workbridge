import { proxyGoogleRedirect } from '@/lib/server/authProxy';

export async function GET(request) {
  return proxyGoogleRedirect(request, 'google/callback');
}
