import type { PrismaTransactionClient } from '../types/index';

/**
 * Locks a `User` row for the rest of the transaction. One lock serializes every per-user write
 * that must not interleave: payout-account writes and the payout decision (PA7, S17), portfolio
 * and career writes (PF8), and notification-preference writes (NC7). Callers take it as the
 * transaction's first statement.
 */
export async function lockUserRow(tx: PrismaTransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}
