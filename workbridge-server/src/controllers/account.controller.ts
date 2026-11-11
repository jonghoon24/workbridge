import type { NextFunction, Response } from 'express';

import { issueTokens, setRefreshTokenCookie } from '../lib/authTokens';
import { changePassword } from '../services/account.service';
import type { ChangePasswordInput } from '../schemas/auth';
import type { AuthedRequest } from '../types/index';

/**
 * `POST /api/auth/change-password` — changes the password and re-issues this device's tokens, so it
 * stays signed in while every other session's refresh token stops working.
 */
export async function postChangePassword(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await changePassword(req.user.id, req.body as ChangePasswordInput, new Date());
    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);
    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
}
