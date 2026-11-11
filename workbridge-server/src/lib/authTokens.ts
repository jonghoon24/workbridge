import type { Response } from 'express';
import type { User } from '@prisma/client';

import { env } from '../env';
import { generateAccessToken, generateRefreshToken } from './jwt';
import type { AuthUserResponse } from '../types/index';

/**
 * Issuing a session: the token pair and the refresh cookie. Shared by every route that logs a
 * user in or re-issues their tokens (`auth.controller.ts`, `account.controller.ts`).
 */

export function setRefreshTokenCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/**
 * Builds the JWT claims — distinct from {@link authUserPayload}, the HTTP response shape. The
 * refresh token also records `passwordChangedAt`, so a later password change ends this session
 * (`refresh`, docs/domain/accounts.md "비밀번호 변경").
 */
export function issueTokens(user: Pick<User, 'id' | 'email' | 'role' | 'passwordChangedAt'>) {
  const payload = { id: user.id, email: user.email, role: user.role };
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken({
    ...payload,
    pwdChangedAt: user.passwordChangedAt?.getTime() ?? null,
  });
  return { accessToken, refreshToken };
}

/** Builds the user object sent to clients — distinct from the JWT claims in {@link issueTokens}. */
export function authUserPayload(user: Pick<User, 'id' | 'email' | 'name' | 'role'>): AuthUserResponse {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
