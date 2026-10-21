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
