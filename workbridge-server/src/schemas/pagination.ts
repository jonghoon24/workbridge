import { z } from 'zod';

import { queryInt } from './common';

/** Expansion list routes: `page` ≥ 1 (default 1), `limit` ≥ 1 (default 20) capped at 50 (CT2). */
export const MAX_PAGE_SIZE = 50;

export const pageQuery = {
  page: queryInt({ min: 1, fallback: 1 }),
  limit: queryInt({ min: 1, fallback: 20 }).transform((limit) => Math.min(limit, MAX_PAGE_SIZE)),
};

export type PageQuery = { page: number; limit: number };

export const pageQuerySchema = z.object(pageQuery);
