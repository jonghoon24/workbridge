import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { generateAccessToken } from '../lib/jwt';
import { authUserPayload, issueTokens, setRefreshTokenCookie } from '../lib/authTokens';
import { AppError } from '../lib/errors';
import { normalizeEmail } from '../lib/email';
import { clearLoginFailures, recordLoginFailure } from '../lib/rateLimitRules';
import { safeEqual } from '../lib/safeEqual';
import { env } from '../env';
import { logger } from '../lib/logger';
import { clientUrl } from '../lib/clientUrl';
import type { AuthedRequest, RefreshTokenPayload } from '../types/index';
import type { GoogleCallbackQuery, LoginInput, SelectRoleInput, SignupInput } from '../schemas/auth';
import jwt from 'jsonwebtoken';

/**
 * The Google OAuth `state` cookie (login CSRF defence). Scoped to the two OAuth routes and
 * short-lived: it only has to survive one trip to Google's consent screen. `SameSite=Lax` still
 * sends it on Google's top-level redirect back to the callback.
 */
export const OAUTH_STATE_COOKIE = 'oauthState';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function oauthStateCookieOptions() {
  return { httpOnly: true, secure: env.isProduction, sameSite: 'lax' as const, path: '/api/auth/google' };
}

export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    // Parsed by `signupBody`.
    const { email, password, name, role } = req.body as SignupInput;

    // Deliberately does NOT filter `deletedAt: null`. `email` is unique at the database
    // level, so a soft-deleted user still occupies the address — filtering here would
    // report it as available and then fail with P2002 on create.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('Email already in use', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, role },
    });

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

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    // Parsed by `loginBody`.
    const { email, password } = req.body as LoginInput;

    // `findFirst`, not `findUnique`: soft-deleted users must not be able to log in, and
    // `deletedAt` is not part of a unique constraint.
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    // Every `Invalid credentials` outcome counts toward the email + IP failure limit — unknown
    // emails included, so the limiter cannot be used to tell accounts apart.
    if (!user || !user.password) {
      await recordLoginFailure(req);
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      await recordLoginFailure(req);
      throw new AppError('Invalid credentials', 401);
    }

    await clearLoginFailures(req);

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

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) {
      throw new AppError('Refresh token not found', 401);
    }

    // `jwt.verify` is typed `string | JwtPayload`; we only ever sign `RefreshTokenPayload` claims.
    let decoded: RefreshTokenPayload;
    try {
      decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    // A still-valid refresh token must stop working once the user is soft-deleted.
    const user = await prisma.user.findFirst({ where: { id: decoded.id, deletedAt: null } });
    if (!user) {
      throw new AppError('User not found', 401);
    }

    // Minted before the password last changed: that session ended with the change (other devices
    // are logged out; the device that changed it got a new token). Compared for equality, not
    // `iat < passwordChangedAt` — `iat` has whole seconds and cannot tell a token minted in the
    // same second apart. A token from before this claim existed reads as `null` (never changed).
    if ((decoded.pwdChangedAt ?? null) !== (user.passwordChangedAt?.getTime() ?? null)) {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const accessToken = generateAccessToken({ id: user.id, email: user.email, role: user.role });

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
}

// The try/catch is load-bearing even though nothing here is awaited: `env` reads are
// throwing getters, and because this function is `async`, a synchronous throw becomes a
// rejected promise. Express 4 does not capture those, so an unhandled rejection would
// terminate the process (Node treats them as fatal by default) instead of returning a
// response. Do not remove it as dead weight.
export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // The callback can only send the browser back to `CLIENT_URL`; without it, fail here (500)
    // rather than after the user has been through Google's consent screen.
    clientUrl();
    // A fresh random `state` per attempt, kept in a cookie and echoed back by Google. The
    // callback accepts only a `state` equal to this browser's cookie, so a callback URL carrying
    // someone else's `code` cannot sign this browser in to their account.
    const state = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      state,
    });

    res.cookie(OAUTH_STATE_COOKIE, state, { ...oauthStateCookieOptions(), maxAge: OAUTH_STATE_MAX_AGE_MS });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    next(err);
  }
}

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
    const { code, state } = res.locals.query as GoogleCallbackQuery;
    const expectedState: unknown = req.cookies?.[OAUTH_STATE_COOKIE];
    // One attempt per cookie, whatever the outcome.
    res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions());

    if (!code) {
      return res.redirect(`${client}/login?error=oauth_failed`);
    }

    if (
      !state
      || typeof expectedState !== 'string' || !expectedState
      || !safeEqual(state, expectedState)
    ) {
      return res.redirect(`${client}/login?error=oauth_failed`);
    }

    // Exchange code for tokens
    const tokenResponse = await axios.post<{ access_token: string }>('https://oauth2.googleapis.com/token', {
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code',
    });

    const { access_token } = tokenResponse.data;

    // Get user info
    // Google's userinfo response; `id` and `email` are checked below before anything uses them.
    const userInfoResponse = await axios.get<{ id?: unknown; email?: unknown; name: string; picture?: string }>(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );

    const { id: googleId, email: rawEmail, name, picture } = userInfoResponse.data;
    // Stored and compared in the same form as signup and login, so the same-email check below also
    // catches an address that differs from an existing account's only by case or spaces.
    const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : rawEmail;

    // Without both values there is nothing to match on — and Prisma reads `{ googleId: undefined }`
    // as no filter at all, which would match any account.
    if (typeof googleId !== 'string' || !googleId || typeof email !== 'string' || !email) {
      throw new Error('Google profile is missing its id or email');
    }

    // An existing account is matched by `googleId` only. An equal email alone does not prove the
    // caller owns that account (whether or not Google marks it verified), so such a login is not
    // linked and gets no session: it goes back to the login screen with its own error code.
    let user = await prisma.user.findFirst({ where: { googleId, deletedAt: null } });

    if (!user) {
      const sameEmail = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
      if (sameEmail) {
        return res.redirect(`${client}/login?error=email_account_exists`);
      }
    }

    let needsRoleSelection = false;

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { profileImage: user.profileImage || picture },
      });
      needsRoleSelection = !user.roleSelected;
    } else {
      user = await prisma.user.create({
        data: {
          email,
          name,
          googleId,
          profileImage: picture,
          role: 'FREELANCER',
          roleSelected: false,
        },
      });
      needsRoleSelection = true;
    }

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    const params = new URLSearchParams({
      token: accessToken,
      needsRoleSelection: String(needsRoleSelection),
    });

    res.redirect(`${client}/auth/callback?${params.toString()}`);
  } catch (err) {
    logger.warn('google oauth failed', { err });
    res.redirect(`${client}/login?error=oauth_failed`);
  }
}

export async function selectRole(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `selectRoleBody`.
    const { role } = req.body as SelectRoleInput;

    const user = await prisma.user.findFirst({ where: { id: req.user.id, deletedAt: null } });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (user.roleSelected) {
      throw new AppError('Role has already been selected', 400);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role, roleSelected: true },
    });

    const { accessToken, refreshToken } = issueTokens(updated);
    setRefreshTokenCookie(res, refreshToken);

    res.json({ accessToken, user: authUserPayload(updated) });
  } catch (err) {
    next(err);
  }
}
