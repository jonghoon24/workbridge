import type { Prisma, Settlement, SettlementStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { DAY_MS, HOUR_MS, nextKstWeekday } from '../lib/time';
import { sumBreakdowns } from '../lib/money';
import { bankName, maskAccountNumber } from '../lib/banks';
import { notifyRecipients } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import type { TemplateType, TemplateVars } from '../lib/notifications/templates';
import { getPayoutProvider } from '../lib/payout/provider';
import { enqueueJob } from '../jobs/queue';
import { PermanentJobError } from '../jobs/errors';
import type { PrismaTransactionClient } from '../types/index';

/**
 * Weekly settlements and payouts (BEHAVIOR.md "Settlements", S1–S17, M19–M22).
 */

/** M19: periods are one week; the batch runs 3 h after the period ends (Monday 03:00 KST). */
export const SETTLEMENT_PERIOD_MS = 7 * DAY_MS;
export const BATCH_DELAY_MS = 3 * HOUR_MS;
/** M19: payout at `periodEnd + 2 days 10 h` (Wednesday 10:00 KST). */
export const PAYOUT_DELAY_MS = 2 * DAY_MS + 10 * HOUR_MS;
/** M22. */
export const MAX_PAYOUT_ATTEMPTS = 3;
export const PAYOUT_RETRY_MS = DAY_MS;

const MONDAY = 1;
const WEDNESDAY = 3;
const MAX_FAILURE_REASON = 500;

export const WEEKLY_BATCH_KEY_PREFIX = 'settlement.weeklyBatch:';

/** The recurring slot after `now`: the next Monday 03:00 KST (M19). */
export function nextBatchAt(now: Date): Date {
  return nextKstWeekday(now, MONDAY, 3);
}

/** `settlement.weeklyBatch:<periodStart ISO>` for the batch slot at `runAt`. */
export function weeklyBatchDedupeKey(runAt: Date): string {
  const periodStart = new Date(runAt.getTime() - SETTLEMENT_PERIOD_MS - BATCH_DELAY_MS);
  return `${WEEKLY_BATCH_KEY_PREFIX}${periodStart.toISOString()}`;
}

/** J6: the period start encoded in a batch job's `dedupeKey`; `null` if absent or malformed. */
export function periodStartFromDedupeKey(dedupeKey: string | null): Date | null {
  if (!dedupeKey?.startsWith(WEEKLY_BATCH_KEY_PREFIX)) return null;
  const iso = dedupeKey.slice(WEEKLY_BATCH_KEY_PREFIX.length);
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) || date.toISOString() !== iso ? null : date;
}

export function payoutDedupeKey(settlementId: string, scheduledPayoutAt: Date): string {
  return `settlement.payout:${settlementId}:${scheduledPayoutAt.toISOString()}`;
}

export function enqueuePayout(tx: PrismaTransactionClient, settlementId: string, scheduledPayoutAt: Date) {
  return enqueueJob(tx, {
    type: 'settlement.payout',
    payload: { settlementId, scheduledPayoutAt: scheduledPayoutAt.toISOString() },
    runAt: scheduledPayoutAt,
    dedupeKey: payoutDedupeKey(settlementId, scheduledPayoutAt),
  });
}

async function notifyFreelancer(
  tx: PrismaTransactionClient,
  freelancer: { id: string; deletedAt: Date | null },
  type: TemplateType,
  vars: TemplateVars,
): Promise<void> {
  await notifyRecipients(tx, [freelancer], { type, ...renderTemplate(type, vars) });
}

// ---------------------------------------------------------------------------
// Weekly batch (S4–S6)
// ---------------------------------------------------------------------------

export interface BatchResult {
  periodStart: Date;
  periodEnd: Date;
  freelancers: number;
  created: number;
  failed: number;
}

/**
 * S4–S6 for the period starting at `periodStart`. One transaction per freelancer; a failure
 * rolls back only that freelancer, and the batch throws at the end so the queue retries it.
 */
export async function runWeeklyBatch(periodStart: Date, now: Date): Promise<BatchResult> {
  const periodEnd = new Date(periodStart.getTime() + SETTLEMENT_PERIOD_MS);
  const scheduledPayoutAt = new Date(periodEnd.getTime() + PAYOUT_DELAY_MS);

  const rows = await prisma.settlementItem.findMany({
    where: { settlementId: null, approvedAt: { lt: periodEnd } },
    distinct: ['freelancerId'],
    select: { freelancerId: true },
  });

  let created = 0;
  const failures: string[] = [];
  for (const { freelancerId } of rows) {
    try {
      if (await settleFreelancer(freelancerId, periodStart, periodEnd, scheduledPayoutAt, now)) created += 1;
    } catch (err) {
      failures.push(freelancerId);
      logger.warn('settlement batch failed for a freelancer', { freelancerId, err });
    }
  }

  if (failures.length > 0) {
    throw new Error(`settlement batch failed for ${failures.length} of ${rows.length} freelancers`);
  }
  return { periodStart, periodEnd, freelancers: rows.length, created, failed: 0 };
}

/** Returns true when a new settlement was created. */
async function settleFreelancer(
  freelancerId: string,
  periodStart: Date,
  periodEnd: Date,
  scheduledPayoutAt: Date,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // S5: insert-or-ignore on (freelancerId, periodStart), then read — never Prisma's upsert.
    const inserted = await tx.settlement.createMany({
      data: [{
        freelancerId,
        periodStart,
        periodEnd,
        scheduledPayoutAt,
        itemCount: 0,
        grossAmount: 0,
        feeAmount: 0,
        feeVatAmount: 0,
        netAmount: 0,
      }],
      skipDuplicates: true,
    });
    const isNew = inserted.count === 1;
    const settlement = await tx.settlement.findUniqueOrThrow({
      where: { freelancerId_periodStart: { freelancerId, periodStart } },
    });

    // S5: lock it with a conditional write on SCHEDULED; anything else leaves the items for
    // the next batch. (A just-inserted row is SCHEDULED and already ours.)
    const locked = await tx.settlement.updateMany({
      where: { id: settlement.id, status: 'SCHEDULED' },
      data: { updatedAt: now },
    });
    if (locked.count === 0) return false;

    const attached = await tx.settlementItem.updateMany({
      where: { freelancerId, settlementId: null, approvedAt: { lt: periodEnd } },
      data: { settlementId: settlement.id },
    });
    if (attached.count === 0) {
      // Another batch run took the items between our read and this transaction.
      if (isNew) await tx.settlement.delete({ where: { id: settlement.id } });
      return false;
    }

    const items = await tx.settlementItem.findMany({
      where: { settlementId: settlement.id },
      select: { grossAmount: true, feeAmount: true, feeVatAmount: true, netAmount: true },
    });
    const total = sumBreakdowns(items.map((i) => ({ gross: i.grossAmount, fee: i.feeAmount, vat: i.feeVatAmount, net: i.netAmount })));
    await tx.settlement.update({
      where: { id: settlement.id },
      data: {
        itemCount: items.length,
        grossAmount: total.gross,
        feeAmount: total.fee,
        feeVatAmount: total.vat,
        netAmount: total.net,
      },
    });

    if (isNew) {
      const freelancer = await tx.user.findUniqueOrThrow({ where: { id: freelancerId }, select: { id: true, deletedAt: true } });
      await notifyFreelancer(tx, freelancer, 'SETTLEMENT_SCHEDULED', { settlementId: settlement.id, amount: total.net });
      await enqueuePayout(tx, settlement.id, settlement.scheduledPayoutAt);
    }
    return isNew;
  }, { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Payout (S7–S12, S17)
// ---------------------------------------------------------------------------

export type PayoutOutcome = 'skipped' | 'on_hold' | 'paid' | 'retry_scheduled' | 'failed';

const PAYABLE: SettlementStatus[] = ['SCHEDULED', 'FAILED'];

/** The conditions under which S7 lets a payout proceed, as a `where` for conditional writes. */
function payableWhere(settlementId: string, scheduledPayoutAt: Date): Prisma.SettlementWhereInput {
  return {
    id: settlementId,
    status: { in: PAYABLE },
    scheduledPayoutAt,
    payoutAttempts: { lt: MAX_PAYOUT_ATTEMPTS },
  };
}

export async function runPayout(settlementId: string, scheduledPayoutAtIso: string, now: Date): Promise<PayoutOutcome> {
  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId } });
  if (!settlement) throw new PermanentJobError(`settlement ${settlementId} does not exist`);

  // S7: a rescheduled settlement belongs to a newer job.
  if (settlement.scheduledPayoutAt.toISOString() !== scheduledPayoutAtIso) return 'skipped';
  if (!PAYABLE.includes(settlement.status) || settlement.payoutAttempts >= MAX_PAYOUT_ATTEMPTS) return 'skipped';

  const scheduledPayoutAt = settlement.scheduledPayoutAt;

  const decision = await prisma.$transaction(async (tx) => {
    // S17: serialize with payout-account writes on the freelancer's user row.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${settlement.freelancerId} FOR UPDATE`;
    const freelancer = await tx.user.findUniqueOrThrow({
      where: { id: settlement.freelancerId },
      select: { id: true, deletedAt: true },
    });
    const account = await tx.payoutAccount.findUnique({ where: { userId: settlement.freelancerId } });

    // S8: no account, or a soft-deleted freelancer → ON_HOLD (attempts unchanged).
    if (!account || freelancer.deletedAt) {
      const held = await tx.settlement.updateMany({
        where: payableWhere(settlementId, scheduledPayoutAt),
        data: { status: 'ON_HOLD' },
      });
      if (held.count === 1) {
        await notifyFreelancer(tx, freelancer, 'SETTLEMENT_ON_HOLD', { settlementId, amount: settlement.netAmount });
      }
      return held.count === 1 ? { kind: 'on_hold' as const } : { kind: 'skipped' as const };
    }

    // S9: the conditional transition, then the row it produced (still under its lock).
    const moved = await tx.settlement.updateMany({
      where: payableWhere(settlementId, scheduledPayoutAt),
      data: {
        status: 'PROCESSING',
        payoutAttempts: { increment: 1 },
        bankName: bankName(account.bankCode),
        accountNumberMasked: maskAccountNumber(account.accountNumber),
        accountHolder: account.holderName,
      },
    });
    if (moved.count === 0) return { kind: 'skipped' as const };
    const processing = await tx.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    return { kind: 'transfer' as const, processing, account, freelancer };
  });

  if (decision.kind !== 'transfer') return decision.kind;

  const { processing, account, freelancer } = decision;
  let reference: string;
  try {
    ({ reference } = await getPayoutProvider().transfer({
      settlementId,
      attempt: processing.payoutAttempts,
      amount: processing.netAmount,
      bankCode: account.bankCode,
      accountNumber: account.accountNumber,
      holderName: account.holderName,
    }));
  } catch (err) {
    return recordTransferFailure(processing, freelancer, err, now);
  }

  // S10
  await prisma.$transaction(async (tx) => {
    const paid = await tx.settlement.updateMany({
      where: { id: settlementId, status: 'PROCESSING' },
      data: { status: 'PAID', paidAt: now, providerReference: reference, failureReason: null },
    });
    if (paid.count === 1) {
      await notifyFreelancer(tx, freelancer, 'SETTLEMENT_PAID', { settlementId, amount: processing.netAmount });
    }
  });
  return 'paid';
}

/** S11: FAILED, then a retry 24 h later while attempts remain; the last failure notifies. */
async function recordTransferFailure(
  processing: Settlement,
  freelancer: { id: string; deletedAt: Date | null },
  err: unknown,
  now: Date,
): Promise<PayoutOutcome> {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, MAX_FAILURE_REASON) || 'transfer failed';
  const retry = processing.payoutAttempts < MAX_PAYOUT_ATTEMPTS;
  const nextAt = new Date(now.getTime() + PAYOUT_RETRY_MS);

  return prisma.$transaction(async (tx) => {
    const failed = await tx.settlement.updateMany({
      where: { id: processing.id, status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        failureReason: reason,
        ...(retry ? { scheduledPayoutAt: nextAt } : {}),
      },
    });
    if (failed.count === 0) return 'skipped';

    if (retry) {
      await enqueuePayout(tx, processing.id, nextAt);
      return 'retry_scheduled';
    }
    await notifyFreelancer(tx, freelancer, 'SETTLEMENT_FAILED', { settlementId: processing.id, amount: processing.netAmount });
    return 'failed';
  });
}

// ---------------------------------------------------------------------------
// Reads (S13–S16)
// ---------------------------------------------------------------------------

export interface SettlementListQuery {
  status?: SettlementStatus;
  page: number;
  limit: number;
}

export async function listSettlements(freelancerId: string, query: SettlementListQuery) {
  const where: Prisma.SettlementWhereInput = { freelancerId, ...(query.status ? { status: query.status } : {}) };
  const [total, settlements] = await Promise.all([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  return {
    settlements,
    meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) },
  };
}

/** S15. Every settlement lands in exactly one of `scheduled`, `onHold`, `failed`, `paidTotal`. */
export async function settlementSummary(freelancerId: string, now: Date = new Date()) {
  const [unsettled, settlements, account] = await Promise.all([
    prisma.settlementItem.findMany({
      where: { freelancerId, settlementId: null },
      select: { grossAmount: true, feeAmount: true, feeVatAmount: true, netAmount: true },
    }),
    prisma.settlement.findMany({
      where: { freelancerId },
      select: { status: true, netAmount: true, payoutAttempts: true, scheduledPayoutAt: true },
    }),
    prisma.payoutAccount.findUnique({ where: { userId: freelancerId }, select: { id: true } }),
  ]);

  const bucket = () => ({ count: 0, net: 0 });
  const scheduled = bucket();
  const onHold = bucket();
  const failed = bucket();
  let paidTotal = 0;
  let nextPayoutAt: Date | null = null;

  for (const s of settlements) {
    if (s.status === 'PAID') {
      paidTotal += s.netAmount;
    } else if (s.status === 'ON_HOLD') {
      onHold.count += 1;
      onHold.net += s.netAmount;
    } else if (s.status === 'FAILED' && s.payoutAttempts >= MAX_PAYOUT_ATTEMPTS) {
      failed.count += 1;
      failed.net += s.netAmount;
    } else {
      scheduled.count += 1;
      scheduled.net += s.netAmount;
      if (!nextPayoutAt || s.scheduledPayoutAt < nextPayoutAt) nextPayoutAt = s.scheduledPayoutAt;
    }
  }

  const unsettledTotal = sumBreakdowns(unsettled.map((i) => ({ gross: i.grossAmount, fee: i.feeAmount, vat: i.feeVatAmount, net: i.netAmount })));
  return {
    unsettled: { count: unsettled.length, ...unsettledTotal },
    scheduled,
    onHold,
    failed,
    paidTotal,
    nextBatchAt: nextBatchAt(now),
    nextPayoutAt,
    hasPayoutAccount: account !== null,
  };
}

/** S16. Project deletion only changes `projectDeleted` (S2). */
export async function getSettlement(settlementId: string, freelancerId: string) {
  const settlement = await prisma.settlement.findUnique({
    where: { id: settlementId },
    include: {
      items: {
        orderBy: { approvedAt: 'asc' },
        include: {
          milestone: { select: { title: true, sequence: true } },
          contract: { select: { projectId: true, project: { select: { title: true, deletedAt: true } } } },
        },
      },
    },
  });
  if (!settlement) throw new AppError('Settlement not found', 404);
  if (settlement.freelancerId !== freelancerId) throw new AppError('Not authorized', 403);

  const { items, ...row } = settlement;
  return {
    ...row,
    items: items.map((item) => ({
      id: item.id,
      milestoneId: item.milestoneId,
      milestoneTitle: item.milestone.title,
      milestoneSequence: item.milestone.sequence,
      contractId: item.contractId,
      projectId: item.contract.projectId,
      projectTitle: item.contract.project.title,
      projectDeleted: item.contract.project.deletedAt !== null,
      grossAmount: item.grossAmount,
      feeRateBps: item.feeRateBps,
      feeAmount: item.feeAmount,
      feeVatAmount: item.feeVatAmount,
      netAmount: item.netAmount,
      approvedAt: item.approvedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Rescheduling held settlements (PA4)
// ---------------------------------------------------------------------------

/** PA4: every ON_HOLD settlement → SCHEDULED for the next Wednesday 10:00 KST after `now`. */
export async function rescheduleHeldSettlements(tx: PrismaTransactionClient, freelancerId: string, now: Date): Promise<number> {
  const held = await tx.settlement.findMany({ where: { freelancerId, status: 'ON_HOLD' }, select: { id: true } });
  const scheduledPayoutAt = nextKstWeekday(now, WEDNESDAY, 10);
  for (const { id } of held) {
    const { count } = await tx.settlement.updateMany({
      where: { id, status: 'ON_HOLD' },
      data: { status: 'SCHEDULED', scheduledPayoutAt, failureReason: null },
    });
    if (count === 1) await enqueuePayout(tx, id, scheduledPayoutAt);
  }
  return held.length;
}
