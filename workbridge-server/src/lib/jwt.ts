import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

import { env } from '../env';
import type { JwtUserPayload } from '../types/index';

/** The claims we mint. `iat`/`exp` are added by `jsonwebtoken` itself. */
type TokenPayload = Pick<JwtUserPayload, 'id' | 'email' | 'role'>;

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

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as ExpiresIn,
  });
}
