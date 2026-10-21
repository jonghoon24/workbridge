/**
 * Money rules of the expansion domains (BEHAVIOR.md "Money and milestone rules"). Every amount
 * here is a whole number of won and every calculation is integer arithmetic on basis points, so
 * there is no floating-point drift even though the columns are `Float` (a pre-existing debt that
 * is deliberately left alone). New code computes fees and rounding **only** through this file.
 */

/** M1: the platform fee, 10% of the approved milestone amount, in basis points. */
export const PLATFORM_FEE_RATE_BPS = 1000;
/** M2: VAT on the fee, 10% of the fee. */
export const FEE_VAT_RATE_BPS = 1000;
const BPS_DENOMINATOR = 10_000;

/** M8: milestones per contract. */
export const MIN_MILESTONES = 1;
export const MAX_MILESTONES = 10;
/** M10: minimum amount of a milestone in a plan submitted with `PUT`. */
export const MIN_MILESTONE_AMOUNT = 10_000;

export interface PayoutBreakdown {
  gross: number;
  fee: number;
  vat: number;
  net: number;
}

/** M7: a (possibly fractional) contract amount in whole won — half up, like `Math.round`. */
export function wholeWon(amount: number): number {
  return Math.round(amount);
}

/** `floor(amount × bps / 10000)` in integers (M3). */
function applyRate(amount: number, bps: number): number {
  return Math.floor((amount * bps) / BPS_DENOMINATOR);
}

/**
 * M3: `fee = floor(gross × rate)`, `vat = floor(fee × 10%)`, `net = gross − fee − vat`.
 * Fractions of a won are dropped. 1,234,567 → 123,456 / 12,345 / 1,098,766.
 */
export function payoutBreakdown(gross: number, feeRateBps: number = PLATFORM_FEE_RATE_BPS): PayoutBreakdown {
  if (!Number.isSafeInteger(gross) || gross < 0) {
    throw new RangeError(`gross must be a non-negative whole number of won, got ${gross}`);
  }
  const fee = applyRate(gross, feeRateBps);
  const vat = applyRate(fee, FEE_VAT_RATE_BPS);
  return { gross, fee, vat, net: gross - fee - vat };
}

/** M5: a settlement's totals are the sums of its items, never recomputed from the total gross. */
export function sumBreakdowns(items: readonly PayoutBreakdown[]): PayoutBreakdown {
  return items.reduce<PayoutBreakdown>(
    (total, item) => ({
      gross: total.gross + item.gross,
      fee: total.fee + item.fee,
      vat: total.vat + item.vat,
      net: total.net + item.net,
    }),
    { gross: 0, fee: 0, vat: 0, net: 0 },
  );
}
