import prisma from '../../src/lib/prisma';

export { prisma };

/**
 * Every table, ordered so the list is easy to keep complete. `CASCADE` means the order does
 * not actually matter for correctness, but a missing table silently leaks fixtures between
 * tests — so add new models here when the schema grows.
 */
const TABLES = [
  'Job',
  'RateLimitCounter',
  'Notification',
  'Review',
  'Payment',
  'Contract',
  'Application',
  'ProjectBookmark',
  'PricingAnalysis',
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
