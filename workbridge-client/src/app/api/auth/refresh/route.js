import { proxyAuthRequest } from '@/lib/server/authProxy';

export async function POST(request) {
  return proxyAuthRequest(request, 'refresh');
}
