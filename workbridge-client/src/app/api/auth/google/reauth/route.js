import { proxyGoogleRedirect } from '@/lib/server/authProxy';

// Google 재인증 시작. 로그인 시작(`../route.js`)과 같이 백엔드가 심은 `state` 쿠키를 이 출처로 옮긴다.
export async function GET(request) {
  return proxyGoogleRedirect(request, 'google/reauth');
}
