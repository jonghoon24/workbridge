import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Constant-time string comparison for shared secrets and tokens. Both sides are hashed first:
 * `timingSafeEqual` throws a RangeError on unequal lengths, which would otherwise turn a short
 * guess into a 500 and leak the length.
 */
export function safeEqual(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}
