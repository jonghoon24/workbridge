/**
 * KST helpers. Calendar rules ("today", day windows, daily schedules) use a **fixed UTC+9
 * offset** — Korea has no daylight saving, so no timezone library is needed (BEHAVIOR.md
 * rule 11). Every function takes the instant to reason about rather than reading the clock,
 * so callers (and tests) control time.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Start of the window of length `windowMs` that contains `now`, with windows aligned to KST
 * boundaries. For windows that divide 9 hours evenly (15 min, 1 h, …) this is identical to UTC
 * alignment; for a day window it is 00:00 KST.
 */
export function startOfKstWindow(now: Date, windowMs: number): Date {
  const shifted = now.getTime() + KST_OFFSET_MS;
  return new Date(Math.floor(shifted / windowMs) * windowMs - KST_OFFSET_MS);
}

/** The instant at which the KST calendar day containing `now` began (00:00 KST). */
export function startOfKstDay(now: Date = new Date()): Date {
  return startOfKstWindow(now, DAY_MS);
}

/** The KST calendar date of `instant`, as `YYYY-MM-DD`. */
export function kstDateString(instant: Date): string {
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The last millisecond (23:59:59.999 KST) of a `YYYY-MM-DD` calendar date. Used for deadlines
 * given as a date: "due on 2026-11-01" means "until that day ends in Korea".
 */
export function kstDateToEndOfDay(date: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new RangeError(`Expected a YYYY-MM-DD date, got "${date}"`);
  }

  const [, y, m, d] = match.map(Number);
  const startUtc = Date.UTC(y, m - 1, d);
  const roundTrip = new Date(startUtc);
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== m - 1 || roundTrip.getUTCDate() !== d) {
    throw new RangeError(`Not a calendar date: "${date}"`);
  }

  return new Date(startUtc - KST_OFFSET_MS + DAY_MS - 1);
}

/** The first instant strictly after `now` whose KST wall clock reads `hour:minute`. */
export function nextKstTimeOfDay(now: Date, hour: number, minute = 0): Date {
  const candidate = new Date(startOfKstDay(now).getTime() + hour * HOUR_MS + minute * MINUTE_MS);
  return candidate > now ? candidate : new Date(candidate.getTime() + DAY_MS);
}

/**
 * The first instant strictly after `now` that falls on KST `weekday` (0 = Sunday … 6 =
 * Saturday) at `hour:minute`.
 */
export function nextKstWeekday(now: Date, weekday: number, hour = 0, minute = 0): Date {
  const dayStart = startOfKstDay(now);
  // The KST weekday of `dayStart`: shift into KST wall-clock time and read it as UTC.
  const todayWeekday = new Date(dayStart.getTime() + KST_OFFSET_MS).getUTCDay();
  const daysAhead = (weekday - todayWeekday + 7) % 7;
  const candidate = new Date(dayStart.getTime() + daysAhead * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS);
  return candidate > now ? candidate : new Date(candidate.getTime() + 7 * DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Calendar months (BEHAVIOR.md PF2): portfolio and career periods are `YYYY-MM` months, stored
// as the first instant of that month in KST and returned as `YYYY-MM` again.
// ---------------------------------------------------------------------------------------------

// Years from 1900: earlier (above all year 0000) yields instants Prisma cannot store, and no
// portfolio or career plausibly predates it.
const MONTH_PATTERN = /^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/;

/** True for a `YYYY-MM` string with a year from 1900 and a month from `01` to `12`. */
export function isKstMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/**
 * The first instant of a `YYYY-MM` month in KST (`2025-03` → `2025-02-28T15:00:00.000Z`).
 * Throws a `RangeError` for anything else.
 */
export function kstMonthToDate(month: string): Date {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new RangeError(`Expected a YYYY-MM month, got "${month}"`);
  }
  // `setUTCFullYear` rather than `Date.UTC`, which maps years 0–99 onto 1900–1999.
  const start = new Date(0);
  start.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, 1);
  return new Date(start.getTime() - KST_OFFSET_MS);
}

/** The KST month containing `instant`, as `YYYY-MM`. */
export function kstMonthString(instant: Date): string {
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 7);
}

/** `kstMonthString`, passing `null` through — for optional month columns. */
export function kstMonthOrNull(instant: Date | null): string | null {
  return instant ? kstMonthString(instant) : null;
}

/**
 * A month as a running count (`year × 12 + month − 1`), so month arithmetic is plain integer
 * arithmetic: `kstMonthIndex('2022-02') − kstMonthIndex('2020-01') + 1` = 26 months inclusive.
 */
export function kstMonthIndex(month: string): number {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new RangeError(`Expected a YYYY-MM month, got "${month}"`);
  }
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}
