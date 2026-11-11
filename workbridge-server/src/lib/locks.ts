import { AppError } from './errors';
import type { PrismaTransactionClient } from '../types/index';

/**
 * Locks a `User` row for the rest of the transaction. One lock serializes every per-user write
 * that must not interleave: payout-account writes and the payout decision, portfolio and career
 * writes, notification-preference writes, and withdrawal. Callers take it as the transaction's
 * first statement (withdrawal is the documented exception, docs/DATABASE.md). Returns the row's
 * `deletedAt` as it is now that the row is locked.
 */
export async function lockUserRow(tx: PrismaTransactionClient, userId: string): Promise<{ deletedAt: Date | null } | null> {
  const rows = await tx.$queryRaw<{ deletedAt: Date | null }[]>`
    SELECT "deletedAt" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** The message of `requireActiveUser`, reused by the checks that repeat it under the lock. */
export const ACCOUNT_INACTIVE = 'Account is no longer active';

/**
 * {@link lockUserRow} for a user's own request: a caller who withdrew while the request waited
 * for the lock (`requireActiveUser` passed before the withdrawal committed) is refused with the
 * guard's 401 instead of writing data back into the withdrawn account. The settlement batch and
 * the payout decision keep `lockUserRow`: they still process a deleted freelancer (ON_HOLD).
 */
export async function lockActiveUserRow(tx: PrismaTransactionClient, userId: string): Promise<void> {
  const row = await lockUserRow(tx, userId);
  if (!row || row.deletedAt) throw new AppError(ACCOUNT_INACTIVE, 401);
}
