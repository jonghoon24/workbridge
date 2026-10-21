import { z } from 'zod';

import { queryEnum } from './common';
import { pageQuery } from './pagination';

/** `GET /api/contracts` (CT2). */
export const contractListQuery = z.object({
  status: queryEnum(['PENDING', 'ACTIVE', 'COMPLETED'] as const),
  ...pageQuery,
});
