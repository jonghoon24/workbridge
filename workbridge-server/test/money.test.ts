import { describe, expect, it } from 'vitest';

import {
  FEE_VAT_RATE_BPS,
  MAX_MILESTONES,
  MIN_MILESTONE_AMOUNT,
  PLATFORM_FEE_RATE_BPS,
  payoutBreakdown,
  sumBreakdowns,
  wholeWon,
} from '../src/lib/money';
import { bankName, isBankCode, maskAccountNumber } from '../src/lib/banks';
import { holderMatches } from '../src/services/payoutAccount.service';
import {
  nextBatchAt,
  periodStartFromDedupeKey,
  weeklyBatchDedupeKey,
} from '../src/services/settlements.service';
import { defaultMilestoneDueDate } from '../src/services/milestones.service';

/** Pure money, bank and calendar rules — BEHAVIOR.md "Money and milestone rules". */

describe('fee arithmetic', () => {
  it('pins the constants: 10% fee, 10% VAT on the fee, 10,000 minimum, 10 milestones [M1] [M2] [M8] [M10]', () => {
    expect(PLATFORM_FEE_RATE_BPS).toBe(1000);
    expect(FEE_VAT_RATE_BPS).toBe(1000);
    expect(MIN_MILESTONE_AMOUNT).toBe(10_000);
    expect(MAX_MILESTONES).toBe(10);
  });

  it.each([
    [1_234_567, 123_456, 12_345, 1_098_766],
    [9_500_000, 950_000, 95_000, 8_455_000],
    [10_000, 1_000, 100, 8_900],
    [15_005, 1_500, 150, 13_355],
    [9, 0, 0, 9],
    [0, 0, 0, 0],
  ])('%i → fee %i, vat %i, net %i (floored) [M3]', (gross, fee, vat, net) => {
    expect(payoutBreakdown(gross)).toEqual({ gross, fee, vat, net });
  });

  it('uses the snapshotted rate when given one [M4]', () => {
    expect(payoutBreakdown(1_000_000, 500)).toEqual({ gross: 1_000_000, fee: 50_000, vat: 5_000, net: 945_000 });
  });

  it('rejects a fractional or negative gross rather than rounding silently [M6]', () => {
    expect(() => payoutBreakdown(1.5)).toThrow(RangeError);
    expect(() => payoutBreakdown(-1)).toThrow(RangeError);
  });

  it('sums items instead of recomputing from the total: two 15,005 items → fee 3,000, not 3,001 [M5]', () => {
    const items = [payoutBreakdown(15_005), payoutBreakdown(15_005)];
    expect(sumBreakdowns(items)).toEqual({ gross: 30_010, fee: 3_000, vat: 300, net: 26_710 });
    expect(payoutBreakdown(30_010).fee).toBe(3_001);
  });

  it('rounds a contract amount half up to whole won [M7]', () => {
    expect(wholeWon(2_500_000.5)).toBe(2_500_001);
    expect(wholeWon(2_500_000.49)).toBe(2_500_000);
    expect(wholeWon(4_000_000)).toBe(4_000_000);
  });
});

describe('payout account rules', () => {
  it('masks every digit but the last four [M23]', () => {
    expect(maskAccountNumber('110123456789')).toBe('********6789');
    expect(maskAccountNumber('1234567890')).toBe('******7890');
  });

  it('knows the twelve fixed bank codes [M23]', () => {
    expect(isBankCode('004')).toBe(true);
    expect(isBankCode('092')).toBe(true);
    expect(isBankCode('999')).toBe(false);
    expect(isBankCode('constructor')).toBe(false);
    expect(bankName('090')).toBe('카카오뱅크');
  });

  it('matches the holder name ignoring whitespace and letter case [M23]', () => {
    expect(holderMatches('박 지윤', '박지윤')).toBe(true);
    expect(holderMatches(' Jane  Doe ', 'jane doe')).toBe(true);
    expect(holderMatches('박지윤', '박지원')).toBe(false);
  });
});

describe('KST calendar', () => {
  it('the default milestone is due at the end of the KST day 30 days later [M9]', () => {
    // 2026-10-21 14:00 KST → 2026-11-20 23:59:59.999 KST
    expect(defaultMilestoneDueDate(new Date('2026-10-21T05:00:00.000Z')).toISOString())
      .toBe('2026-11-20T14:59:59.999Z');
    // 2026-10-21 23:30 KST is still the 21st in Korea although it is the 21st 14:30 UTC.
    expect(defaultMilestoneDueDate(new Date('2026-10-21T14:30:00.000Z')).toISOString())
      .toBe('2026-11-20T14:59:59.999Z');
    // 2026-10-22 00:30 KST is already the 22nd in Korea (still the 21st in UTC).
    expect(defaultMilestoneDueDate(new Date('2026-10-21T15:30:00.000Z')).toISOString())
      .toBe('2026-11-21T14:59:59.999Z');
  });

  it('the weekly batch slot is the next Monday 03:00 KST, keyed by its period start [M19] [J6]', () => {
    // Tuesday 2026-10-20 14:00 KST
    const runAt = nextBatchAt(new Date('2026-10-20T05:00:00.000Z'));
    expect(runAt.toISOString()).toBe('2026-10-25T18:00:00.000Z'); // Mon 2026-10-26 03:00 KST
    const key = weeklyBatchDedupeKey(runAt);
    expect(key).toBe('settlement.weeklyBatch:2026-10-18T15:00:00.000Z'); // Mon 2026-10-19 00:00 KST
    expect(periodStartFromDedupeKey(key)?.toISOString()).toBe('2026-10-18T15:00:00.000Z');
  });

  it('a slot exactly at Monday 03:00 KST is not its own next slot [M19]', () => {
    const slot = new Date('2026-10-25T18:00:00.000Z');
    expect(nextBatchAt(slot).toISOString()).toBe('2026-11-01T18:00:00.000Z');
  });

  it('rejects missing or malformed slot keys [J6]', () => {
    expect(periodStartFromDedupeKey(null)).toBeNull();
    expect(periodStartFromDedupeKey('settlement.weeklyBatch:not-a-date')).toBeNull();
    expect(periodStartFromDedupeKey('settlement.weeklyBatch:2026-10-18')).toBeNull();
    expect(periodStartFromDedupeKey('maintenance.cleanup:2026-10-18')).toBeNull();
  });
});
