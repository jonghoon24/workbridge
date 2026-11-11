import type { NextFunction, Request, Response } from 'express';

import { generateAccessToken } from '../lib/jwt';
import { authUserPayload, issueTokens, setRefreshTokenCookie } from '../lib/authTokens';
import { clearLoginFailures, recordLoginFailure } from '../lib/rateLimitRules';
import { safeEqual } from '../lib/safeEqual';
import { logger } from '../lib/logger';
import { clientUrl } from '../lib/clientUrl';
import { OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_MS, oauthStateCookieOptions } from '../lib/googleOAuth';
import { parseOAuthState } from '../lib/reauth';
import {
  chooseRole,
  completeGoogleLogin,
  googleLoginStart,
  registerWithPassword,
  userForRefreshToken,
  verifyPasswordLogin,
} from '../services/auth.service';
import { completeGoogleReauth, reauthFailurePath } from '../services/reauth.service';
import type { AuthedRequest } from '../types/index';
import type { GoogleCallbackQuery, LoginInput, SelectRoleInput, SignupInput } from '../schemas/auth';

/**
 * `/api/auth/*`. The services return the user a session is for; this file issues the tokens, sets
 * and clears the cookies, and sends every redirect.
 */

/** `POST /api/auth/signup`. The body was parsed by `signupBody`. */
export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await registerWithPassword(req.body as SignupInput);

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    res.status(201).json({
      accessToken,
      user: authUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
}

/** `POST /api/auth/login`. The body was parsed by `loginBody`. */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await verifyPasswordLogin(req.body as LoginInput, {
      record: () => recordLoginFailure(req),
      clear: () => clearLoginFailures(req),
    });

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    res.json({
      accessToken,
      user: authUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
}

/** `POST /api/auth/logout`: clears the refresh cookie. */
export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

/** `POST /api/auth/refresh`: a new access token for the refresh cookie's session. */
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const token: unknown = req.cookies?.refreshToken;
    const user = await userForRefreshToken(token);

    const accessToken = generateAccessToken({ id: user.id, email: user.email, role: user.role });

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /api/auth/google`: sends the browser to Google's consent screen.
 *
 * The try/catch is load-bearing even though nothing here is awaited: `env` reads are
 * throwing getters, and because this function is `async`, a synchronous throw becomes a
 * rejected promise. Express 4 does not capture those, so an unhandled rejection would
 * terminate the process (Node treats them as fatal by default) instead of returning a
 * response. Do not remove it as dead weight.
 */
export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // The callback can only send the browser back to `CLIENT_URL`; without it, fail here (500)
    // rather than after the user has been through Google's consent screen.
    clientUrl();
    const { url, state } = googleLoginStart();

    res.cookie(OAUTH_STATE_COOKIE, state, { ...oauthStateCookieOptions(), maxAge: OAUTH_STATE_MAX_AGE_MS });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

/** `GET /api/auth/google/callback`: every outcome is a redirect to the frontend. */
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  // Every outcome below is a redirect to the frontend, so without its address there is nowhere to
  // send the browser: a 500 that names `CLIENT_URL`, logged once by `errorHandler`.
  let client: string;
  try {
    client = clientUrl();
  } catch (err) {
    return next(err);
  }

  try {
    // Parsed by `googleCallbackQuery`: a missing, empty or malformed value reads as absent.
    const { code, state, error } = res.locals.query as GoogleCallbackQuery;
    const expectedState: unknown = req.cookies?.[OAUTH_STATE_COOKIE];
    // One attempt per cookie, whatever the outcome.
    res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions());

    const stateMatches = state !== undefined
      && typeof expectedState === 'string' && expectedState !== ''
      && safeEqual(state, expectedState);
    const intent = state ? parseOAuthState(state) : { intent: 'login' as const };

    // A re-authentication (docs/domain/accounts.md "Google 재인증") goes back to the screen of its
    // purpose, never to the login screen, and never logs anyone in. A state that does not match the
    // cookie only picks that screen: nothing is exchanged and no proof is issued.
    if (intent.intent === 'reauth') {
      if (!stateMatches) {
        logger.warn('google reauth failed', { purpose: intent.purpose, code: 'failed', reason: 'state mismatch' });
        return res.redirect(`${client}${reauthFailurePath(intent.purpose, 'failed')}`);
      }
      const location = await completeGoogleReauth({ purpose: intent.purpose, code, error }, new Date());
      return res.redirect(`${client}${location}`);
    }

    if (!code || intent.intent !== 'login' || !stateMatches) {
      return res.redirect(`${client}/login?error=oauth_failed`);
    }

    const result = await completeGoogleLogin(code);
    if (result.kind === 'emailAccountExists') {
      return res.redirect(`${client}/login?error=email_account_exists`);
    }

    const { accessToken, refreshToken } = issueTokens(result.user);
    setRefreshTokenCookie(res, refreshToken);

    const params = new URLSearchParams({
      token: accessToken,
      needsRoleSelection: String(result.needsRoleSelection),
    });

    res.redirect(`${client}/auth/callback?${params.toString()}`);
  } catch (err) {
    logger.warn('google oauth failed', { err });
    res.redirect(`${client}/login?error=oauth_failed`);
  }
}

/** `POST /api/auth/select-role`: the first role choice, with re-issued tokens for the new role. */
export async function selectRole(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { role } = req.body as SelectRoleInput;
    const updated = await chooseRole(req.user.id, role);

    const { accessToken, refreshToken } = issueTokens(updated);
    setRefreshTokenCookie(res, refreshToken);

    res.json({ accessToken, user: authUserPayload(updated) });
  } catch (err) {
    next(err);
  }
}
