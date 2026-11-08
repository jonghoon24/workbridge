import { env } from '../env';
import type { JobType } from './types';

/**
 * Job types switched off by environment flag until production can run them for real
 * (BEHAVIOR.md "Background jobs", J10). Both default to off; each is on only when its flag is
 * exactly `'true'`, read at every runner pass so a flag change needs no restart.
 *
 * The two are gated differently on purpose:
 * - `settlement.payout` is **held**: the runner does not claim it, so it stays `PENDING`. A payout
 *   is money owed; once a real transfer provider is wired in and the flag turned on, every held
 *   payout runs (its handler still re-reads the settlement and skips one that was rescheduled).
 * - `notification.email` is **skipped**: the job runs and marks its delivery `SKIPPED`. An email
 *   is only useful when timely; holding them would send weeks of stale notifications and digests
 *   in one burst on the day the flag is turned on.
 */
export function isPayoutEnabled(): boolean {
  return env.JOB_PAYOUT_ENABLED === 'true';
}

export function isEmailEnabled(): boolean {
  return env.JOB_EMAIL_ENABLED === 'true';
}

/** Types the runner must leave `PENDING` right now. */
export function heldJobTypes(): JobType[] {
  return isPayoutEnabled() ? [] : ['settlement.payout'];
}

/** The `EmailDelivery.error` of a delivery skipped because email is off. */
export const EMAIL_DISABLED = 'Email sending is disabled (JOB_EMAIL_ENABLED)';
