import { proxyAuthRequest } from '@/lib/server/authProxy';

// 비밀번호를 바꾸면 서버가 이 기기의 리프레시 쿠키를 새로 심는다. 일반 프록시(`api/[...path]`)는
// 쿠키를 넘기지 않으므로 다른 인증 경로처럼 전용 라우트로 받는다.
export async function POST(request) {
  return proxyAuthRequest(request, 'change-password');
}
