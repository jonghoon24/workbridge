import jwt from 'jsonwebtoken';

import { env } from '../env';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { exchangeGoogleCode, GOOGLE_AUTH_URL, GOOGLE_ISSUERS } from '../lib/googleOAuth';
import {
  issueReauthProof,
  REAUTH_CLOCK_SKEW_MS,
  REAUTH_MAX_AGE_MS,
  REAUTH_RETURN_PATHS,
  reauthState,
  verifyReauthProof,
} from '../lib/reauth';
import type { ReauthPurpose } from '../lib/reauth';

/**
 * Google re-authentication before a sensitive action (docs/domain/accounts.md "Google 재인증"):
 * the start, the callback's re-authentication branch, and the check the action itself runs.
 */

export const REAUTH_REQUIRED = 'Google re-authentication is required';
export const REAUTH_INVALID = 'Google re-authentication is invalid or expired';

/** Why a re-authentication went back to its screen without a proof (`?reauthError=`). */
export type ReauthErrorCode = 'cancelled' | 'failed' | 'stale' | 'unavailable' | 'account_mismatch';

/** Without `auth_time` the sign-in is refused only in strict mode (`GOOGLE_REAUTH_REQUIRE_AUTH_TIME`). */
function requiresAuthTime(): boolean {
  return env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME === 'true';
}

/**
 * `GET /api/auth/google/reauth`: the Google URL to send the browser to and the `state` to keep in
 * its cookie. `prompt=select_account` makes the user pick (or sign in to) the account themselves;
 * `claims` asks Google for `auth_time`, the sign-in time freshness is judged by. Google has no
 * `prompt=login` or `max_age` to force a new sign-in.
 */
export function googleReauthStart(purpose: ReauthPurpose): { url: string; state: string } {
  const state = reauthState(purpose);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid',
    prompt: 'select_account',
    claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
    state,
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
}

/** The screen of `purpose` with a failure code. */
export function reauthFailurePath(purpose: ReauthPurpose, code: ReauthErrorCode): string {
  return `${REAUTH_RETURN_PATHS[purpose]}?reauthError=${code}`;
}

interface GoogleIdClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  sub?: unknown;
  auth_time?: unknown;
}

class ReauthFailure extends Error {
  constructor(readonly code: ReauthErrorCode, readonly reason: string) {
    super(reason);
  }
}

/** Google's `sub` and `auth_time` from an ID token, once its issuer, audience and expiry check out. */
function readIdToken(idToken: string | undefined, now: Date): { sub: string; authTime: Date | null } {
  if (!idToken) throw new ReauthFailure('failed', 'no id_token');
  // Not signature-checked: it came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7, step 6).
  const claims = jwt.decode(idToken, { json: true }) as GoogleIdClaims | null;
  if (!claims) throw new ReauthFailure('failed', 'unreadable id_token');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new ReauthFailure('failed', 'unexpected issuer');
  }
  if (!audiences.includes(env.GOOGLE_CLIENT_ID)) throw new ReauthFailure('failed', 'unexpected audience');
  // OIDC Core 3.1.3.7 steps 4-5: with more than one audience, the authorized party must be us.
  if (audiences.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID) {
    throw new ReauthFailure('failed', 'unexpected authorized party');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) {
    throw new ReauthFailure('failed', 'expired id_token');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new ReauthFailure('failed', 'no subject');

  const authTime = typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : null;
  return { sub: claims.sub, authTime };
}

/**
 * The callback's re-authentication branch, after its `state` matched this browser's cookie. Returns
 * the path (on the frontend) to send the browser to: the purpose's screen with the proof in the
 * fragment — never sent to a server or logged — or with `?reauthError=`. Issues no session, creates
 * no account and changes no profile.
 */
export async function completeGoogleReauth(
  input: { purpose: ReauthPurpose; code?: string; error?: string },
  now: Date,
): Promise<string> {
  const { purpose } = input;
  try {
    if (input.error === 'access_denied') throw new ReauthFailure('cancelled', 'cancelled at Google');
    if (input.error || !input.code) throw new ReauthFailure('failed', 'no authorization code');

    const tokens = await exchangeGoogleCode(input.code);
    const { sub, authTime } = readIdToken(tokens.id_token, now);

    if (authTime === null) {
      if (requiresAuthTime()) throw new ReauthFailure('unavailable', 'no auth_time from Google');
      // Lax mode: the Google round trip and the linked account are checked, the sign-in time cannot be.
      logger.warn('google reauth without auth_time', { purpose });
    } else if (authTime.getTime() > now.getTime() + REAUTH_CLOCK_SKEW_MS) {
      throw new ReauthFailure('failed', 'auth_time in the future');
    } else if (now.getTime() - authTime.getTime() > REAUTH_MAX_AGE_MS) {
      throw new ReauthFailure('stale', 'Google sign-in is too old');
    }

    const user = await prisma.user.findFirst({ where: { googleId: sub, deletedAt: null }, select: { id: true } });
    if (!user) throw new ReauthFailure('account_mismatch', 'no active account linked to this Google account');

    const proof = issueReauthProof({ userId: user.id, googleSub: sub, purpose, authTime }, now);
    logger.info('google reauth confirmed', { userId: user.id, purpose, authTimeVerified: authTime !== null });
    return `${REAUTH_RETURN_PATHS[purpose]}#reauthToken=${encodeURIComponent(proof)}`;
  } catch (err) {
    if (err instanceof ReauthFailure) {
      logger.warn('google reauth failed', { purpose, code: err.code, reason: err.reason });
      return reauthFailurePath(purpose, err.code);
    }
    logger.warn('google reauth failed', { purpose, code: 'failed', err });
    return reauthFailurePath(purpose, 'failed');
  }
}

/**
 * Refuses (400) unless `token` is an unexpired proof that this user signed in to their linked Google
 * account for `purpose` — in strict mode, one whose freshness Google's `auth_time` backed. 400, not
 * 401: the client reads a 401 as an expired session and logs out.
 */
export function assertRecentGoogleReauth(
  user: { id: string; googleId: string | null },
  token: string | undefined,
  purpose: ReauthPurpose,
  now: Date,
): void {
  if (!token) throw new AppError('REAUTH_REQUIRED', REAUTH_REQUIRED);
  const proof = verifyReauthProof(token, now);
  if (
    !proof
    || proof.userId !== user.id
    || proof.purpose !== purpose
    || user.googleId === null
    || proof.googleSub !== user.googleId
    || (requiresAuthTime() && !proof.authTimeVerified)
  ) {
    throw new AppError('REAUTH_INVALID', REAUTH_INVALID);
  }
}
