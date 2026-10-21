import { PermanentJobError } from '../errors';
import { periodStartFromDedupeKey, runPayout, runWeeklyBatch } from '../../services/settlements.service';
import type { JobHandler } from '../types';

/**
 * J6: the period comes from the slot in the job's `dedupeKey` — never from `runAt`, which a
 * retry moves (S4).
 */
export const settlementWeeklyBatch: JobHandler<'settlement.weeklyBatch'> = async ({ job, now, logger }) => {
  const periodStart = periodStartFromDedupeKey(job.dedupeKey);
  if (!periodStart) throw new PermanentJobError(`weekly batch without a valid slot key: ${job.dedupeKey}`);
  const result = await runWeeklyBatch(periodStart, now);
  logger.info('settlement batch', { periodStart: result.periodStart, freelancers: result.freelancers, created: result.created });
};

/** J7. */
export const settlementPayout: JobHandler<'settlement.payout'> = async ({ payload, now, logger }) => {
  const outcome = await runPayout(payload.settlementId, payload.scheduledPayoutAt, now);
  logger.info('settlement payout', { settlementId: payload.settlementId, outcome });
};
