import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { normalizeEmail } from '../lib/email';
import { env } from '../env';
import { exchangeGoogleCode, GOOGLE_AUTH_URL } from '../lib/googleOAuth';
import type { RefreshTokenPayload } from '../types/index';
import type { LoginInput, SelectRoleInput, SignupInput } from '../schemas/auth';

/**
 * Signing in (docs/domain/accounts.md): email signup and login, the refresh token check, the Google
 * login and the first role choice. Each returns the user a session is issued for; minting the
 * tokens and setting the refresh cookie (`lib/authTokens.ts`) and every redirect stay in
 * `auth.controller.ts`. The Google re-authentication is `reauth.service.ts`.
 */

/** `POST /api/auth/signup`: the new user. */
export async function registerWithPassword(input: SignupInput): Promise<User> {
  const { email, password, name, role } = input;

  // Deliberately does NOT filter `deletedAt: null`. `email` is unique at the database
  // level, so a soft-deleted user still occupies the address — filtering here would
  // report it as available and then fail with P2002 on create.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError('Email already in use', 409);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: { email, password: hashedPassword, name, role },
  });
}

/**
 * The email + IP login-failure count (`LOGIN_FAILURE_RULE`). It is keyed by the request, so the
 * controller binds it (`recordLoginFailure`/`clearLoginFailures`); this file decides when.
 */
export interface LoginFailureCounter {
  record(): Promise<void>;
  clear(): Promise<void>;
}

/** `POST /api/auth/login`: the user whose password matched. */
export async function verifyPasswordLogin(input: LoginInput, failures: LoginFailureCounter): Promise<User> {
  const { email, password } = input;

  // `findFirst`, not `findUnique`: soft-deleted users must not be able to log in, and
  // `deletedAt` is not part of a unique constraint.
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  // Every `Invalid credentials` outcome counts toward the email + IP failure limit — unknown
  // emails included, so the limiter cannot be used to tell accounts apart.
  if (!user || !user.password) {
    await failures.record();
    throw new AppError('Invalid credentials', 401);
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    await failures.record();
    throw new AppError('Invalid credentials', 401);
  }

  await failures.clear();

  return user;
}

/** `POST /api/auth/refresh`: the active user a refresh cookie's token belongs to. */
export async function userForRefreshToken(token: unknown): Promise<User> {
  if (!token) {
    throw new AppError('Refresh token not found', 401);
  }

  // `jwt.verify` is typed `string | JwtPayload`; we only ever sign `RefreshTokenPayload` claims.
  // A cookie value that is not a string (cookie-parser's `j:` JSON values) fails verification.
  let decoded: RefreshTokenPayload;
  try {
    if (typeof token !== 'string') throw new Error('refresh token is not a string');
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

  return user;
}

/**
 * `GET /api/auth/google`: the Google consent URL and the `state` to keep in this browser's cookie —
 * a fresh random value per attempt, echoed back by Google. The callback accepts only a `state` equal
 * to the cookie, so a callback URL carrying someone else's `code` cannot sign this browser in to
 * their account.
 */
export function googleLoginStart(): { url: string; state: string } {
  const state = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    state,
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
}

/** What a Google login's callback ends in, once its `state` was checked. */
export type GoogleLoginResult =
  | { kind: 'signedIn'; user: User; needsRoleSelection: boolean }
  /** No account has this Google id, but an active one has its email: not linked, no session. */
  | { kind: 'emailAccountExists' };

/**
 * `GET /api/auth/google/callback` (login): exchanges `code`, then signs in the account linked to the
 * Google id or creates one (role still to be chosen). Any failure throws; the controller turns it
 * into the login screen's `oauth_failed`.
 */
export async function completeGoogleLogin(code: string): Promise<GoogleLoginResult> {
  // Exchange code for tokens
  const { access_token } = await exchangeGoogleCode(code);

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
      return { kind: 'emailAccountExists' };
    }
  }

  let needsRoleSelection: boolean;

  if (user) {
    // Only while still active: a withdrawal that commits in between must not get a picture back,
    // and one that commits after the write must not get a session — so the read-back has the same
    // condition, and either case is the same failure (the login screen's `oauth_failed`).
    const active = { id: user.id, deletedAt: null };
    const { count } = await prisma.user.updateMany({
      where: active,
      data: { profileImage: user.profileImage || picture },
    });
    user = count === 0 ? null : await prisma.user.findFirst({ where: active });
    if (!user) {
      throw new Error('Google account was withdrawn during login');
    }
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

  return { kind: 'signedIn', user, needsRoleSelection };
}

/**
 * `POST /api/auth/select-role`: a Google signup's one-time role choice; the updated user.
 *
 * One conditional write — only an active account whose role is still to be chosen — so a withdrawal
 * that commits first is never written to, and of two concurrent choices only one lands. When it
 * writes nothing, a re-read tells the cases apart in the same order as before: no active account →
 * 404, role already chosen → 400. The read-back has the same active condition, so a withdrawal
 * that commits right after the write gets no session either.
 */
export async function chooseRole(userId: string, role: SelectRoleInput['role']): Promise<User> {
  const active = { id: userId, deletedAt: null };

  const { count } = await prisma.user.updateMany({
    where: { ...active, roleSelected: false },
    data: { role, roleSelected: true },
  });

  if (count === 0) {
    const user = await prisma.user.findFirst({ where: active, select: { id: true } });
    if (!user) {
      throw new AppError('User not found', 404);
    }
    throw new AppError('Role has already been selected', 400);
  }

  const updated = await prisma.user.findFirst({ where: active });
  if (!updated) {
    throw new AppError('User not found', 404);
  }
  return updated;
}
