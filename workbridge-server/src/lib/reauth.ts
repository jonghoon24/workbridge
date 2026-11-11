import { hkdfSync, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { env } from '../env';
import { MINUTE_MS } from './time';

/**
 * Google re-authentication before a sensitive action (docs/domain/accounts.md "Google 재인증"): the
 * purposes, the OAuth `state` that carries one, and the short-lived proof the callback hands the
 * browser. The flow itself is `services/reauth.service.ts`.
 */

/** The actions a re-authentication can be asked for. Each has a fixed screen to return to. */
export const REAUTH_PURPOSES = ['withdrawal'] as const;
export type ReauthPurpose = (typeof REAUTH_PURPOSES)[number];

/** Where the callback sends the browser back to, per purpose — never a path the client chose. */
export const REAUTH_RETURN_PATHS: Record<ReauthPurpose, string> = {
  withdrawal: '/my/account/withdrawal',
};

/** How long after the Google sign-in (or, without `auth_time`, after the callback) the proof is accepted. */
export const REAUTH_MAX_AGE_MS = 5 * MINUTE_MS;

/** How far in the future Google's `auth_time` may be before it reads as wrong rather than clock drift. */
export const REAUTH_CLOCK_SKEW_MS = MINUTE_MS;

const isPurpose = (value: string): value is ReauthPurpose => (REAUTH_PURPOSES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

const STATE_PREFIX = 'reauth.';

/** A fresh `state` for a re-authentication: `reauth.<purpose>.<random>`. A login's state is the random part alone. */
export function reauthState(purpose: ReauthPurpose): string {
  return `${STATE_PREFIX}${purpose}.${randomBytes(32).toString('base64url')}`;
}

export type OAuthStateIntent =
  | { intent: 'login' }
  | { intent: 'reauth'; purpose: ReauthPurpose }
  | { intent: 'invalid' };

/**
 * What a callback's `state` says it is for. Only trusted once the state equals this browser's
 * cookie; before that it only picks the screen a failure goes back to.
 */
export function parseOAuthState(state: string): OAuthStateIntent {
  if (!state.startsWith(STATE_PREFIX)) return { intent: 'login' };
  const match = /^reauth\.([a-z_]+)\.[A-Za-z0-9_-]+$/.exec(state);
  if (!match || !isPurpose(match[1])) return { intent: 'invalid' };
  return { intent: 'reauth', purpose: match[1] };
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

export const REAUTH_AUDIENCE = 'workbridge:reauth';

/**
 * The proof's signing key, derived from `JWT_ACCESS_SECRET`. A key of its own because `authenticate`
 * does not check `aud`: under the same key a proof would pass as an access token, and the reverse.
 */
function proofKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.JWT_ACCESS_SECRET, '', 'workbridge reauth proof', 32));
}

/** The proof's claims besides `sub` (the WorkBridge user id), `aud`, `iat` and `exp`. */
interface ProofClaims {
  purpose: ReauthPurpose;
  /** The Google account (`sub`) that signed in — must still be the user's `googleId`. */
  gsub: string;
  /** Whether Google's `auth_time` backed the freshness, or only the callback's time did. */
  authTimeVerified: boolean;
}

export interface ReauthProof {
  userId: string;
  purpose: ReauthPurpose;
  googleSub: string;
  authTimeVerified: boolean;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Signs a proof that `userId` signed in to Google account `googleSub` for `purpose`. It expires
 * `REAUTH_MAX_AGE_MS` after `authTime` — Google's sign-in time — or, when Google gave none, after `now`.
 */
export function issueReauthProof(
  input: { userId: string; googleSub: string; purpose: ReauthPurpose; authTime: Date | null },
  now: Date,
): string {
  const claims: ProofClaims & { iat: number; exp: number } = {
    purpose: input.purpose,
    gsub: input.googleSub,
    authTimeVerified: input.authTime !== null,
    iat: seconds(now),
    exp: seconds(new Date((input.authTime ?? now).getTime() + REAUTH_MAX_AGE_MS)),
  };
  return jwt.sign(claims, proofKey(), { algorithm: 'HS256', audience: REAUTH_AUDIENCE, subject: input.userId });
}

/** The proof's claims if it is ours, unexpired at `now` and well formed; otherwise `null`. */
export function verifyReauthProof(token: string, now: Date): ReauthProof | null {
  let payload: unknown;
  try {
    payload = jwt.verify(token, proofKey(), {
      algorithms: ['HS256'],
      audience: REAUTH_AUDIENCE,
      clockTimestamp: seconds(now),
    });
  } catch {
    return null;
  }
  const claims = payload as Partial<ProofClaims> & { sub?: unknown };
  if (
    typeof claims.sub !== 'string' || !claims.sub
    || typeof claims.purpose !== 'string' || !isPurpose(claims.purpose)
    || typeof claims.gsub !== 'string' || !claims.gsub
    || typeof claims.authTimeVerified !== 'boolean'
  ) {
    return null;
  }
  return { userId: claims.sub, purpose: claims.purpose, googleSub: claims.gsub, authTimeVerified: claims.authTimeVerified };
}
