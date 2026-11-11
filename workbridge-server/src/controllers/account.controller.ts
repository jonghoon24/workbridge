import type { NextFunction, Response } from 'express';

import { issueTokens, setRefreshTokenCookie } from '../lib/authTokens';
import { changePassword, getWithdrawalStatus, withdrawAccount } from '../services/account.service';
import type { ChangePasswordInput } from '../schemas/auth';
import type { WithdrawalInput } from '../schemas/account';
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

/** `GET /api/users/me/withdrawal` — whether the caller can withdraw now, and what blocks it. */
export async function getWithdrawal(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getWithdrawalStatus(req.user.id));
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /api/users/me/withdrawal` — withdraws the caller. The refresh cookie is left to the client,
 * which logs out next (the generic proxy does not pass cookies; a later refresh is refused anyway).
 */
export async function postWithdrawal(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await withdrawAccount(req.user.id, req.body as WithdrawalInput, new Date());
    res.json({ message: 'Account withdrawn' });
  } catch (err) {
    next(err);
  }
}
