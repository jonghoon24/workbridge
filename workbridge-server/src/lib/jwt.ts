import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

import { env } from '../env';
import type { JwtUserPayload, RefreshTokenPayload } from '../types/index';

/** The claims we mint. `iat`/`exp` are added by `jsonwebtoken` itself. */
type TokenPayload = Pick<JwtUserPayload, 'id' | 'email' | 'role'>;

/** The refresh token's claims: the access token's plus `pwdChangedAt` (see {@link RefreshTokenPayload}). */
type RefreshTokenClaims = TokenPayload & Pick<RefreshTokenPayload, 'pwdChangedAt'>;

/**
 * `@types/jsonwebtoken` narrows `expiresIn` to `number | StringValue`, where `StringValue`
 * is `ms`'s template-literal type (`"15m"`, `"7d"`, …). A value read from the environment
 * is just `string`, and the compiler cannot prove it matches that pattern — so the cast is
 * unavoidable. An invalid duration still fails at runtime inside `ms`, as it did before.
 */
type ExpiresIn = SignOptions['expiresIn'];

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as ExpiresIn,
  });
}

/**
 * `pwdChangedAt` is the user's `passwordChangedAt` (epoch ms, `null` = never changed) when the token
 * was minted; `refresh` refuses the token once it differs. Omitted, it reads as `null`.
 */
export function generateRefreshToken(payload: RefreshTokenClaims): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as ExpiresIn,
  });
}
