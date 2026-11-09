import type { PayoutAccount } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { bankName, maskAccountNumber } from '../lib/banks';
import { lockUserRow } from '../lib/locks';
import type { PrismaTransactionClient } from '../types/index';
import { rescheduleHeldSettlements } from './settlements.service';

/** The payout account (docs/domain/milestones-payments.md "지급 계좌"). The number is stored in plaintext (#28). */

const LOCKED = 'Payout account cannot be changed while a payout is processing';

/** Never the full number. */
export function serializePayoutAccount(account: PayoutAccount | null) {
  if (!account) return null;
  return {
    bankCode: account.bankCode,
    bankName: bankName(account.bankCode),
    accountNumberMasked: maskAccountNumber(account.accountNumber),
    holderName: account.holderName,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** The holder must be the member — compared ignoring all whitespace and letter case. */
export function holderMatches(holderName: string, userName: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  return normalize(holderName) === normalize(userName);
}

/**
 * The user-row lock shared with the payout decision, then the check that refuses a change or
 * removal while a payout is processing.
 */
async function lockAndAssertNotProcessing(tx: PrismaTransactionClient, userId: string): Promise<void> {
  await lockUserRow(tx, userId);
  const processing = await tx.settlement.count({ where: { freelancerId: userId, status: 'PROCESSING' } });
  if (processing > 0) throw new AppError(LOCKED, 409);
}

export async function getPayoutAccount(userId: string) {
  const account = await prisma.payoutAccount.findUnique({ where: { userId } });
  return { payoutAccount: serializePayoutAccount(account) };
}

export interface PayoutAccountInput {
  bankCode: string;
  /** Digits only (validation already removed hyphens and spaces). */
  accountNumber: string;
  holderName: string;
}

/** Creates or replaces the account and reschedules the freelancer's held settlements. */
export async function putPayoutAccount(userId: string, input: PayoutAccountInput, now: Date = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  if (!holderMatches(input.holderName, user.name)) {
    throw new AppError('Account holder must match your name', 400);
  }

  return prisma.$transaction(async (tx) => {
    await lockAndAssertNotProcessing(tx, userId);
    // A native upsert is safe here: the user-row lock serializes this user's writes.
    const data = { bankCode: input.bankCode, accountNumber: input.accountNumber, holderName: input.holderName };
    const account = await tx.payoutAccount.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    const rescheduledCount = await rescheduleHeldSettlements(tx, userId, now);
    return { payoutAccount: serializePayoutAccount(account), rescheduledCount };
  });
}

/** Idempotent. */
export async function deletePayoutAccount(userId: string) {
  return prisma.$transaction(async (tx) => {
    await lockAndAssertNotProcessing(tx, userId);
    await tx.payoutAccount.deleteMany({ where: { userId } });
    return { payoutAccount: null };
  });
}
