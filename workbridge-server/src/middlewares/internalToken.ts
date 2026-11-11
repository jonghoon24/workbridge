import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { AppError } from '../lib/errors';
import { safeEqual } from '../lib/safeEqual';

/**
 * Guards `/api/internal/*` with the shared `INTERNAL_JOB_TOKEN` instead of a JWT.
 *
 * - Token unset → `next('router')`: the request leaves this router and ends exactly like an
 *   unmatched path (the JSON 404 of `middlewares/notFound.ts`), so the endpoint's existence is not
 *   revealed.
 * - Header missing or wrong → 403, compared in constant time (`safeEqual`).
 */
export function requireInternalToken(req: Request, res: Response, next: NextFunction) {
  const expected = env.INTERNAL_JOB_TOKEN;
  if (!expected) {
    return next('router');
  }

  const provided = req.get('x-internal-token') ?? '';
  if (!safeEqual(provided, expected)) {
    return next(new AppError('INTERNAL_TOKEN_INVALID', 'Invalid internal token'));
  }

  next();
}
