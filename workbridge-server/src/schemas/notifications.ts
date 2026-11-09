import { z } from '../lib/zod';

import { pageQuery } from './pagination';

/**
 * `GET /api/notifications` (BEHAVIOR.md "Notifications"): `limit` ≥ 1, default 20, a larger
 * value capped at 50 — the same rules as CT2's `limit`. An empty value is the default; a
 * fractional (`1.5`), trailing-garbage (`3abc`) or repeated (`?limit=1&limit=2`) value is a 400
 * (rule 12). There is no `page`.
 */
export const notificationListQuery = z.object({
  limit: pageQuery.limit,
});

export type NotificationListQuery = z.infer<typeof notificationListQuery>;
