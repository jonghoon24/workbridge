import { Prisma } from '@prisma/client';

/**
 * A `timestamp(3)` SQL parameter holding the UTC wall time of `date`, for raw queries.
 *
 * Prisma stores `DateTime` columns as `timestamp without time zone` in UTC. A raw `Date`
 * parameter is sent as `timestamptz`, and Postgres converts that to `timestamp` through the
 * **session** `TimeZone` — `Asia/Seoul` on a Korean developer machine — which would shift the
 * value by nine hours. Casting the ISO string instead makes Postgres ignore the `Z` suffix and
 * keep the UTC wall time, matching what Prisma itself writes.
 */
export function sqlTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamp(3)`;
}
