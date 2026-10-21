import { describe, expect, it } from 'vitest';

import {
  kstDateString,
  kstDateToEndOfDay,
  nextKstTimeOfDay,
  nextKstWeekday,
  startOfKstDay,
  startOfKstWindow,
} from '../src/lib/time';

/** KST helpers — BEHAVIOR.md rule 11 (fixed UTC+9, no DST). Pure functions. */

const iso = (date: Date) => date.toISOString();

describe('KST helpers', () => {
  it('startOfKstDay is 00:00 KST of the KST calendar day, not the UTC one', () => {
    // 2026-10-21 23:30 UTC is already 2026-10-22 08:30 KST.
    expect(iso(startOfKstDay(new Date('2026-10-21T23:30:00Z')))).toBe('2026-10-21T15:00:00.000Z');
    // 2026-10-21 14:59 UTC is still 2026-10-21 23:59 KST.
    expect(iso(startOfKstDay(new Date('2026-10-21T14:59:59.999Z')))).toBe('2026-10-20T15:00:00.000Z');
    expect(iso(startOfKstDay(new Date('2026-10-21T15:00:00Z')))).toBe('2026-10-21T15:00:00.000Z');
  });

  it('startOfKstWindow matches UTC alignment for windows dividing nine hours', () => {
    const now = new Date('2026-10-21T01:44:10Z');
    expect(iso(startOfKstWindow(now, 15 * 60_000))).toBe('2026-10-21T01:30:00.000Z');
    expect(iso(startOfKstWindow(now, 3_600_000))).toBe('2026-10-21T01:00:00.000Z');
  });

  it('kstDateString gives the KST calendar date', () => {
    expect(kstDateString(new Date('2026-10-21T14:59:59Z'))).toBe('2026-10-21');
    expect(kstDateString(new Date('2026-10-21T15:00:00Z'))).toBe('2026-10-22');
  });

  it('kstDateToEndOfDay is the last millisecond of that KST date', () => {
    expect(iso(kstDateToEndOfDay('2026-11-01'))).toBe('2026-11-01T14:59:59.999Z');
    expect(() => kstDateToEndOfDay('2026-02-30')).toThrow(RangeError);
    expect(() => kstDateToEndOfDay('2026/11/01')).toThrow(RangeError);
  });

  it('nextKstTimeOfDay is strictly after now', () => {
    // 10:03 KST → tomorrow 04:00 KST.
    expect(iso(nextKstTimeOfDay(new Date('2026-10-21T01:03:00Z'), 4))).toBe('2026-10-21T19:00:00.000Z');
    // 03:59 KST → today 04:00 KST.
    expect(iso(nextKstTimeOfDay(new Date('2026-10-20T18:59:00Z'), 4))).toBe('2026-10-20T19:00:00.000Z');
    // Exactly 04:00 KST → tomorrow.
    expect(iso(nextKstTimeOfDay(new Date('2026-10-20T19:00:00Z'), 4))).toBe('2026-10-21T19:00:00.000Z');
  });

  it('nextKstWeekday finds the next weekday at a KST time, strictly after now', () => {
    // 2026-10-21 is a Wednesday. Next Monday 03:00 KST is 2026-10-26 03:00 KST.
    expect(iso(nextKstWeekday(new Date('2026-10-21T01:00:00Z'), 1, 3))).toBe('2026-10-25T18:00:00.000Z');
    // Monday 02:00 KST → the same Monday at 03:00.
    expect(iso(nextKstWeekday(new Date('2026-10-25T17:00:00Z'), 1, 3))).toBe('2026-10-25T18:00:00.000Z');
    // Monday 03:00 KST exactly → a week later.
    expect(iso(nextKstWeekday(new Date('2026-10-25T18:00:00Z'), 1, 3))).toBe('2026-11-01T18:00:00.000Z');
  });
});
