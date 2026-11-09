import prisma from './prisma';
import { sqlTimestamp } from './sql';
import { startOfKstWindow } from './time';
import { env } from '../env';

/**
 * Fixed-window rate-limit counters in Postgres, so every serverless
 * instance shares one count. Windows are aligned to KST boundaries — identical to UTC for 15
 * minutes and an hour, and 00:00 KST for a day.
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  /** Whole seconds (≥ 1) until the current window ends. */
  retryAfterSec: number;
}

export function isRateLimitEnabled(): boolean {
  return env.RATE_LIMIT_ENABLED !== 'false';
}

function windowOf(now: Date, windowMs: number) {
  const windowStart = startOfKstWindow(now, windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  const retryAfterSec = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
  return { windowStart, expiresAt, retryAfterSec };
}

/**
 * Counts one request against `key` and reports whether it is within `limit`. A single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent hits never lose an increment.
 * Refused requests count too.
 */
export async function hit(key: string, windowMs: number, limit: number, now: Date = new Date()): Promise<RateLimitResult> {
  const { windowStart, expiresAt, retryAfterSec } = windowOf(now, windowMs);

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "expiresAt")
    VALUES (${key}, ${sqlTimestamp(windowStart)}, 1, ${sqlTimestamp(expiresAt)})
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimitCounter"."count" + 1
    RETURNING "count"`;

  const count = Number(rows[0].count);
  return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), retryAfterSec };
}

/** Reads the current count without incrementing. Allowed while fewer than `limit` were counted. */
export async function peek(key: string, windowMs: number, limit: number, now: Date = new Date()): Promise<RateLimitResult> {
  const { windowStart, retryAfterSec } = windowOf(now, windowMs);
  const row = await prisma.rateLimitCounter.findUnique({
    where: { key_windowStart: { key, windowStart } },
    select: { count: true },
  });

  const count = row?.count ?? 0;
  return { allowed: count < limit, count, remaining: Math.max(0, limit - count), retryAfterSec };
}

/** Forgets every window of `key` (e.g. after a successful login). */
export async function reset(key: string): Promise<void> {
  await prisma.rateLimitCounter.deleteMany({ where: { key } });
}
