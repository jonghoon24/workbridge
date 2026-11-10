import { prisma } from './db';
import { makeContractScenario } from './factories';

/**
 * The suite's standing 500 vector, for tests of 500 handling (logging, Sentry).
 *
 * The caller's request is `POST /api/payments` with `{ milestoneId }` for the client and milestone
 * of `fundableMilestone()`: it passes validation and every check, then the payment insert fails at
 * the database because of a temporary `CHECK (false)` — a deterministic unhandled error. (The old
 * vector, a non-string `milestoneId`, is a 400 since the body is validated.)
 */
export function fundableMilestone() {
  return makeContractScenario({
    contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true },
  });
}

/** Runs `fn` while every insert into `Payment` fails at the database. */
export async function withFailingPaymentInsert<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Payment" ADD CONSTRAINT "tmp_no_payments" CHECK (false) NOT VALID`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Payment" DROP CONSTRAINT "tmp_no_payments"`);
  }
}
