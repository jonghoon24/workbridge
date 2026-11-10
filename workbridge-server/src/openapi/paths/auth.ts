import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { googleCallbackQuery, loginBody, selectRoleBody, signupBody } from '../../schemas/auth';
import { AUTHENTICATED, bearer, created, errors, invalid, jsonBody, ok, publicRoute, SECURITY_SCHEMES } from '../common';
import { accessTokenBody, authSession } from '../responses/auth';
import { messageBody } from '../responses/common';

const tags = ['Auth'];

const setsRefreshCookie = z.object({
  'Set-Cookie': z.string().openapi({ description: '`refreshToken` — HttpOnly, SameSite=Lax, 7일' }),
});

const redirect = (description: string) => ({
  description,
  headers: z.object({ Location: z.string().openapi({ format: 'uri' }) }),
});

export function registerAuthPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/auth/signup',
    operationId: 'signup',
    tags,
    summary: '이메일 회원가입',
    description: '가입과 동시에 로그인된다. 이메일은 앞뒤 공백만 지우고 대소문자는 그대로 둔다.',
    security: publicRoute,
    request: { body: jsonBody(signupBody) },
    responses: {
      201: { ...created(authSession, '가입하고 로그인됨'), headers: setsRefreshCookie },
      ...errors(invalid(), { 409: ['`Email already in use` — 이미 쓰는 이메일(탈퇴한 계정 포함)'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/login',
    operationId: 'login',
    tags,
    summary: '이메일 로그인',
    description:
      '이메일은 가입과 같이 앞뒤 공백만 지우고 대소문자는 그대로 비교한다. '
      + '레이트 리밋: 같은 IP의 모든 시도 15분에 20회, 같은 이메일+IP의 실패 15분에 5회. 한도 검사는 요청 검증보다 먼저다.',
    security: publicRoute,
    request: { body: jsonBody(loginBody) },
    responses: {
      200: { ...ok(authSession, '로그인됨'), headers: setsRefreshCookie },
      ...errors(invalid(), {
        401: ['`Invalid credentials` — 이메일이나 비밀번호가 틀림, 탈퇴한 계정, 비밀번호 없는(구글) 계정'],
        429: ['`Too many requests. Try again later.` — 로그인 한도 초과'],
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/logout',
    operationId: 'logout',
    tags,
    summary: '로그아웃',
    description:
      '`refreshToken` 쿠키를 지운다. 인증이 필요 없다 — Access Token이 만료된 뒤에도 로그아웃할 수 있어야 한다. '
      + '발급된 토큰을 무효로 만들지는 않는다.',
    security: publicRoute,
    responses: {
      200: ok(messageBody, '`Logged out successfully`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/refresh',
    operationId: 'refresh',
    tags,
    summary: 'Access Token 갱신',
    description: '`refreshToken` 쿠키로 새 Access Token을 발급한다. 리프레시 토큰은 그대로 둔다.',
    security: [{ [SECURITY_SCHEMES.refreshCookie]: [] }],
    responses: {
      200: ok(accessTokenBody, '새 Access Token'),
      ...errors({
        401: [
          '`Refresh token not found` — `refreshToken` 쿠키가 없음',
          '`Invalid or expired refresh token` — 쿠키가 위조됐거나 만료됨',
          '`User not found` — 탈퇴한 사용자',
        ],
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/select-role',
    operationId: 'selectRole',
    tags,
    summary: '역할 선택(구글 첫 로그인)',
    description: '구글로 처음 가입한 사용자가 한 번만 역할을 고른다. 새 역할이 담긴 토큰을 다시 발급한다.',
    security: bearer,
    request: { body: jsonBody(selectRoleBody) },
    responses: {
      200: { ...ok(authSession, '역할이 정해지고 토큰이 다시 발급됨'), headers: setsRefreshCookie },
      ...errors(invalid('`Role has already been selected` — 이미 역할을 골랐음'), AUTHENTICATED, {
        404: ['`User not found` — 탈퇴한 사용자'],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/auth/google',
    operationId: 'googleAuth',
    tags,
    summary: '구글 로그인 시작',
    description: '구글 동의 화면으로 보낸다. 로그인 CSRF를 막는 `state`를 `oauthState` 쿠키(10분)에 둔다.',
    security: publicRoute,
    responses: {
      302: redirect('구글 OAuth 동의 화면으로 이동'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/auth/google/callback',
    operationId: 'googleCallback',
    tags,
    summary: '구글 로그인 콜백',
    description:
      '언제나 리디렉션으로 끝나고 400을 내지 않는다. 성공하면 `CLIENT_URL/auth/callback?token=…&needsRoleSelection=…`, '
      + '실패(코드 없음, `state`가 `oauthState` 쿠키와 다름, 구글 호출 실패)하면 `CLIENT_URL/login?error=oauth_failed`로 보낸다. '
      + '기존 계정과는 `googleId`로만 연결한다. 이 Google 계정과 연결되지 않은 계정이 같은 이메일을 쓰고 있으면 연결하지도 세션을 '
      + '발급하지도 않고 `CLIENT_URL/login?error=email_account_exists`로 보낸다(Google이 이메일을 인증했어도 같다).',
    security: publicRoute,
    request: { query: googleCallbackQuery },
    responses: {
      302: redirect('클라이언트로 이동(성공, `error=oauth_failed` 또는 `error=email_account_exists`)'),
    },
  });
}
