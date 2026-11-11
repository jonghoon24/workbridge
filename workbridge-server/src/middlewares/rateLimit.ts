import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors';
import { hit, isRateLimitEnabled, peek } from '../lib/rateLimit';
import { ruleKey } from '../lib/rateLimitRules';
import type { RateLimitRule } from '../types/index';

export interface RateLimitOptions {
  /** `hit` counts this request (default); `peek` only checks a count kept elsewhere. */
  mode?: 'hit' | 'peek';
}

/**
 * Enforces one rule: over the limit → `Retry-After` + 429. Stack several
 * to apply several rules; a request refused by one never reaches (or counts toward) the next.
 * `RATE_LIMIT_ENABLED` is read per request.
 */
export function rateLimit(rule: RateLimitRule, options: RateLimitOptions = {}) {
  const check = options.mode === 'peek' ? peek : hit;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isRateLimitEnabled()) return next();

      const key = ruleKey(rule, req);
      if (key === null) return next();

      const result = await check(key, rule.windowMs, rule.limit, new Date());
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        throw new AppError('RATE_LIMITED', 'Too many requests. Try again later.');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
