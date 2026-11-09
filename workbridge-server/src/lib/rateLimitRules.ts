import type { Request } from 'express';

import { clientIp } from './clientIp';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';
import { hit, isRateLimitEnabled, reset } from './rateLimit';
import type { JwtUserPayload, RateLimitRule } from '../types/index';

/**
 * The rate-limit rules: login (docs/domain/accounts.md) and AI rate analysis
 * (docs/domain/projects-contracts.md). The client IP comes from `clientIp()` (`lib/clientIp.ts`).
 */

function normalizedEmail(req: Request): string | null {
  const email: unknown = req.body?.email;
  return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
}

/** Every login attempt from one IP, whatever its outcome. */
export const LOGIN_IP_RULE: RateLimitRule = {
  name: 'login.ip',
  windowMs: 15 * MINUTE_MS,
  limit: 20,
  key: (req) => clientIp(req),
};

/**
 * Failed logins for one email from one IP. The middleware only *peeks*; `login` counts a
 * failure with {@link recordLoginFailure} right before its 401 and clears the count on success.
 * Unknown emails count the same as known ones, so this cannot enumerate accounts.
 */
export const LOGIN_FAILURE_RULE: RateLimitRule = {
  name: 'login.failure',
  windowMs: 15 * MINUTE_MS,
  limit: 5,
  key: (req) => {
    const email = normalizedEmail(req);
    return email ? `${email}:${clientIp(req)}` : null;
  },
};

// The analyze rules run after `authenticate`, so `req.user` is set.
const analyzeKey = (req: Request) => (req as { user?: JwtUserPayload }).user?.id ?? null;

/** AI pricing analysis, per user per hour. Every call counts — the provider bills per request. */
export const ANALYZE_HOURLY_RULE: RateLimitRule = {
  name: 'analyze.hour',
  windowMs: HOUR_MS,
  limit: 5,
  key: analyzeKey,
};

/** AI pricing analysis, per user per KST day. */
export const ANALYZE_DAILY_RULE: RateLimitRule = {
  name: 'analyze.day',
  windowMs: DAY_MS,
  limit: 20,
  key: analyzeKey,
};

export function ruleKey(rule: RateLimitRule, req: Request): string | null {
  const key = rule.key(req);
  return key === null ? null : `${rule.name}:${key}`;
}

/** Counts a `401 Invalid credentials` against the email + IP. */
export async function recordLoginFailure(req: Request, now: Date = new Date()): Promise<void> {
  const key = isRateLimitEnabled() ? ruleKey(LOGIN_FAILURE_RULE, req) : null;
  if (key) await hit(key, LOGIN_FAILURE_RULE.windowMs, LOGIN_FAILURE_RULE.limit, now);
}

/** Clears the failure count after a successful login. */
export async function clearLoginFailures(req: Request): Promise<void> {
  const key = isRateLimitEnabled() ? ruleKey(LOGIN_FAILURE_RULE, req) : null;
  if (key) await reset(key);
}
