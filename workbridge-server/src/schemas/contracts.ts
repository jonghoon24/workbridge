import { z } from '../lib/zod';

import { queryEnum } from './common';
import { pageQuery } from './pagination';

/** `GET /api/contracts`: optional `status` filter plus pagination. */
export const contractListQuery = z.object({
  status: queryEnum(['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const),
  ...pageQuery,
});
