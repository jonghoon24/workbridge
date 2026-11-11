import { PrismaClient } from '@prisma/client';

import prisma from '../../src/lib/prisma';

export { prisma };

/**
 * A client with its own two-connection pool, for the test side of a race: a transaction that
 * holds a row lock, and the `pg_locks` poll that watches the app queue behind it. Neither may
 * borrow from the app's pool. Prisma sizes that pool from the CPU count (`num_cpus * 2 + 1`,
 * only 3 on a 2-vCPU CI runner); when the holder and the poll take slots there, the app's
 * blocked transactions fill the rest, the poll waits for a connection that only `release()`
 * would free, and the pool stays wedged for every later test in the file. `$disconnect()` it
 * in a `finally`.
 */
export function sideClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '2');
  return new PrismaClient({ datasourceUrl: url.toString() });
}

/**
 * Every table, ordered so the list is easy to keep complete. `CASCADE` means the order does
 * not actually matter for correctness, but a missing table silently leaks fixtures between
 * tests — so add new models here when the schema grows.
 */
const TABLES = [
  'Job',
  'RateLimitCounter',
  'AttachmentUpload',
  'EmailDelivery',
  'NotificationPreference',
  'Notification',
  'Review',
  'MessageAttachment',
  'Message',
  'ConversationParticipant',
  'Conversation',
  'PortfolioItem',
  'Career',
  'SettlementItem',
  'Settlement',
  'PayoutAccount',
  'MilestoneAttachment',
  'MilestoneSubmission',
  'Payment',
  'Milestone',
  'Contract',
  'Application',
  'ProjectBookmark',
  'Project',
  'User',
] as const;

/** Truncates every table. Called before each test by `test/setup.ts`. */
export async function resetDb(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

/**
 * Guard against ever pointing the suite at a real database. `resetDb` truncates
 * everything, so a misconfigured `DATABASE_URL` would wipe development data.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not look like a test database (${url}). `
      + 'The suite truncates every table. Create one with `bash scripts/test-db.sh`.',
    );
  }
}
