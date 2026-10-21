import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { AppError } from '../lib/errors';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Guards `/api/internal/*` with the shared `INTERNAL_JOB_TOKEN` instead of a JWT.
 *
 * - Token unset → `next('router')`: the request leaves this router and ends exactly like an
 *   unmatched path, so the endpoint's existence is not revealed.
 * - Header missing or wrong → 403. Both sides are hashed first: `timingSafeEqual` throws a
 *   RangeError on unequal lengths, which would otherwise turn a short token into a 500.
 */
export function requireInternalToken(req: Request, res: Response, next: NextFunction) {
  const expected = env.INTERNAL_JOB_TOKEN;
  if (!expected) {
    return next('router');
  }

  const provided = req.get('x-internal-token') ?? '';
  if (!timingSafeEqual(digest(provided), digest(expected))) {
    return next(new AppError('Invalid internal token', 403));
  }

  next();
}
