import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { AppError } from '../lib/errors';

/**
 * `POST /api/payments/dev-complete` only: 403 unless `ALLOW_PAYMENT_BYPASS === 'true'`, before
 * anything else — body validation included. Read per request, so a stale
 * module-load value cannot open the bypass. Must be `false` in production.
 */
export function requirePaymentBypass(_req: Request, _res: Response, next: NextFunction) {
  if (env.ALLOW_PAYMENT_BYPASS !== 'true') {
    return next(new AppError('PAYMENT_BYPASS_DISABLED', 'Payment bypass is disabled'));
  }
  next();
}
