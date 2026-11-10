import { queryInt } from './common';

/**
 * Paginated list routes (`GET /api/notifications` uses `limit` alone): `page` 1–1,000,000
 * (default 1); `limit` ≥ 1 (default 20), capped at 50. The page bound keeps `skip = (page − 1) × limit` far inside what Prisma accepts — an
 * unbounded page overflowed int64 and surfaced as a 500 leaking Prisma internals.
 */
export const MAX_PAGE_SIZE = 50;
export const MAX_PAGE = 1_000_000;

export const pageQuery = {
  page: queryInt({ min: 1, max: MAX_PAGE, fallback: 1 }),
  limit: queryInt({ min: 1, fallback: 20 })
    .transform((limit) => Math.min(limit, MAX_PAGE_SIZE))
    .openapi({ description: `${MAX_PAGE_SIZE}보다 크면 ${MAX_PAGE_SIZE}로 줄인다.` }),
};
