import { Prisma } from '@prisma/client';
import type { Payment } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { env } from '../env';
import { markFunded } from './milestones.service';
import type { PaymentConfirmInput } from '../schemas/payments';

/**
 * Payments are per milestone (docs/domain/milestones-payments.md "안전결제"): create or resume a
 * payment order, confirm it with TossPayments, the development bypass, and the client's payment
 * list. Request bodies are parsed by `schemas/payments.ts` in the route, after `requireActiveUser`.
 */

/**
 * The milestone a payment request names, with what the checks need. Missing, or its contract's
 * project soft-deleted → 404.
 */
async function findMilestoneForPayment(milestoneId: string) {
  const milestone = await prisma.milestone.findFirst({
    where: { id: milestoneId, contract: { project: { deletedAt: null } } },
    include: { contract: true, payment: true },
  });
  if (!milestone) {
    throw new AppError('Milestone not found', 404);
  }
  return milestone;
}

/**
 * How long a confirm's claim on a PENDING payment (`confirmStartedAt`) blocks another confirm. The
 * provider call is cut off at `CONFIRM_PROVIDER_TIMEOUT_MS`, well inside this, so a live confirm
 * has always finished calling the provider before its claim can expire; the lease only matters
 * when a confirm never reports back (the function was killed mid-call), so the client is not
 * locked out of that order for good.
 */
const CONFIRM_CLAIM_LEASE_MS = 60_000;

/**
 * The TossPayments confirm call's timeout — half the claim lease, leaving room for the database
 * writes after it. A timeout takes the ordinary failure path (FAILED, 400).
 */
const CONFIRM_PROVIDER_TIMEOUT_MS = 30_000;

/** Milestones are funded in order: any lower-sequence milestone still PENDING blocks funding this one. */
async function hasUnfundedPredecessor(contractId: string, sequence: number): Promise<boolean> {
  const count = await prisma.milestone.count({
    where: { contractId, sequence: { lt: sequence }, status: 'PENDING' },
  });
  return count > 0;
}

/**
 * `Payment.milestoneId` is unique, so of two requests that both read "no payment yet" and insert,
 * the loser fails with P2002 once the winner has committed. Nothing the loser wrote survives (its
 * insert, or its whole transaction, failed), so it runs once more and answers as if it had arrived
 * second: it now sees the winner's payment and takes the sequential path (resume, idempotent
 * repeat, or 409). Caught here, outside any interactive transaction (REVIEW #5). The retry cannot
 * collide again — it finds the winner's row, and payment rows are never deleted.
 */
async function retryOnceOnPaymentConflict<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return attempt();
    }
    throw err;
  }
}

type PaymentOrder = { orderId: string; amount: number; paymentId: string };

/** The fields of TossPayments' confirm response this file reads, unchecked — hence `Number()` below. */
interface TossConfirmResponse {
  totalAmount: unknown;
  status: unknown;
}

/**
 * `POST /api/payments`: creates the milestone's payment order (`created`), or resumes a PENDING
 * one or reopens a FAILED one under a new `orderId` (not `created`).
 */
export function openPayment(milestoneId: string, clientId: string) {
  return retryOnceOnPaymentConflict(() => openPaymentOrder(milestoneId, clientId));
}

/** Creates, resumes or retries the milestone's payment for `openPayment`. */
async function openPaymentOrder(
  milestoneId: string,
  clientId: string,
): Promise<{ created: boolean; order: PaymentOrder }> {
  const milestone = await findMilestoneForPayment(milestoneId);
  const { contract, payment } = milestone;

  if (contract.clientId !== clientId) {
    throw new AppError('Not authorized', 403);
  }

  if (contract.status !== 'ACTIVE') {
    throw new AppError('Contract must be active to proceed with payment', 400);
  }

  if (await hasUnfundedPredecessor(contract.id, milestone.sequence)) {
    throw new AppError('Earlier milestones must be funded first', 400);
  }

  if (milestone.status !== 'PENDING') {
    throw new AppError('Milestone is already funded', 409);
  }

  if (payment?.status === 'COMPLETED') {
    // Only reachable in an inconsistent state: milestone PENDING, payment COMPLETED.
    throw new AppError('Payment already completed for this milestone', 409);
  }

  if (payment?.status === 'PENDING') {
    return {
      created: false,
      order: { orderId: payment.orderId, amount: payment.amount, paymentId: payment.id },
    };
  }

  if (payment?.status === 'FAILED') {
    const orderId = uuidv4();
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        amount: milestone.amount,
        status: 'PENDING',
        paymentKey: null,
        orderId,
        // The failed attempt's claim belongs to the old order; the new one starts unclaimed.
        confirmStartedAt: null,
      },
    });

    return { created: false, order: { orderId, amount: updated.amount, paymentId: updated.id } };
  }

  if (payment) {
    // REFUNDED
    throw new AppError('Payment cannot be created for this milestone', 409);
  }

  const orderId = uuidv4();

  // A concurrent create of the same milestone fails here with P2002: `retryOnceOnPaymentConflict`.
  const created = await prisma.payment.create({
    data: {
      contractId: contract.id,
      milestoneId: milestone.id,
      clientId,
      amount: milestone.amount,
      status: 'PENDING',
      orderId,
    },
  });

  return { created: true, order: { orderId, amount: created.amount, paymentId: created.id } };
}

/**
 * `POST /api/payments/confirm`: claims the PENDING payment, confirms it with TossPayments, and
 * completes the payment and funds the milestone in one transaction. `requestedAmount` is a
 * positive whole number of won (`paymentConfirmBody`).
 */
export async function confirmTossPayment(clientId: string, input: PaymentConfirmInput, now: Date) {
  const { paymentKey, orderId, amount: requestedAmount } = input;

  // A payment whose project is soft-deleted is not found — before anything is captured.
  const payment = await prisma.payment.findFirst({
    where: { orderId, milestone: { contract: { project: { deletedAt: null } } } },
  });

  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  if (payment.clientId !== clientId) {
    throw new AppError('Not authorized', 403);
  }

  if (payment.status !== 'PENDING') {
    throw new AppError('Payment has already been processed', 409);
  }

  if (requestedAmount !== payment.amount) {
    throw new AppError('Payment amount does not match the contract amount', 400);
  }

  // The read above can be stale: two confirms may both see PENDING. Claiming the payment is a
  // conditional write, so exactly one of them goes on to call the provider; the other is a 409.
  const claimed = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      status: 'PENDING',
      OR: [
        { confirmStartedAt: null },
        { confirmStartedAt: { lt: new Date(now.getTime() - CONFIRM_CLAIM_LEASE_MS) } },
      ],
    },
    data: { confirmStartedAt: now },
  });
  if (claimed.count === 0) {
    throw new AppError('Payment has already been processed', 409);
  }

  // Verify with Toss Payments
  try {
    // Deliberately `string | undefined` rather than a required env var: the template
    // literal below stringifies an unset key, so a missing TOSS_SECRET_KEY still surfaces
    // as a 400 "Payment verification failed" from Toss. Kept on purpose — promoting it to
    // required would turn that into a 500 instead.
    const secretKey = env.TOSS_SECRET_KEY;
    const credentials = Buffer.from(`${secretKey}:`).toString('base64');

    const { data: tossPayment } = await axios.post<TossConfirmResponse>(
      'https://api.tosspayments.com/v1/payments/confirm',
      { paymentKey, orderId, amount: requestedAmount },
      {
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
        timeout: CONFIRM_PROVIDER_TIMEOUT_MS,
      }
    );

    if (Number(tossPayment.totalAmount) !== payment.amount || tossPayment.status !== 'DONE') {
      throw new AppError('Payment verification failed', 400);
    }

    // The payment and the milestone's funding commit together. `markFunded` is a no-op,
    // never an error, when a concurrent confirm already funded the milestone.
    return await prisma.$transaction(async (tx) => {
      const completed = await tx.payment.update({
        where: { orderId },
        data: { status: 'COMPLETED', paymentKey },
      });
      await markFunded(tx, payment.milestoneId, now);
      return completed;
    });
  } catch {
    // Known bug #3: the cause is discarded. Any failure after capture — including a database write —
    // lands here too. The FAILED write is conditional on PENDING so a confirm that
    // lost a race never turns the winner's COMPLETED payment back into FAILED.
    await prisma.payment.updateMany({
      where: { orderId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });

    throw new AppError('Payment verification failed', 400);
  }
}

/**
 * `POST /api/payments/dev-complete` (`requirePaymentBypass` has already refused the request unless
 * the bypass is on): completes the milestone's payment without the provider and funds the
 * milestone. `created` when there was no payment row yet.
 */
export function completePaymentWithoutProvider(milestoneId: string, clientId: string, now: Date) {
  return retryOnceOnPaymentConflict(() => completeMilestonePayment(milestoneId, clientId, now));
}

/** Completes (or creates) the milestone's payment and funds the milestone, for `completePaymentWithoutProvider`. */
async function completeMilestonePayment(
  milestoneId: string,
  clientId: string,
  now: Date,
): Promise<{ created: boolean; payment: Payment }> {
  const milestone = await findMilestoneForPayment(milestoneId);
  const { contract, payment } = milestone;

  if (contract.clientId !== clientId) {
    throw new AppError('Not authorized', 403);
  }

  if (contract.status !== 'ACTIVE') {
    throw new AppError('Contract must be active to proceed with payment', 400);
  }

  if (await hasUnfundedPredecessor(contract.id, milestone.sequence)) {
    throw new AppError('Earlier milestones must be funded first', 400);
  }

  if (milestone.status !== 'PENDING') {
    if (payment?.status === 'COMPLETED') {
      return { created: false, payment };
    }
    throw new AppError('Milestone is already funded', 409);
  }

  if (payment?.status === 'REFUNDED') {
    throw new AppError('Payment cannot be completed for a refunded milestone', 409);
  }

  const paymentData = {
    amount: milestone.amount,
    // `as const` keeps the literal from widening to `string`, which Prisma's
    // `PaymentStatus` enum input would reject.
    status: 'COMPLETED' as const,
    paymentKey: `dev_bypass_${milestone.id}`,
  };

  // Complete in place (or create) and fund the milestone in one transaction. A concurrent call that
  // also creates fails on the unique `milestoneId`, rolling this whole transaction back; the P2002
  // is caught outside it, by `retryOnceOnPaymentConflict`.
  const result = await prisma.$transaction(async (tx) => {
    const saved = payment
      ? await tx.payment.update({ where: { id: payment.id }, data: paymentData })
      : await tx.payment.create({
        data: {
          ...paymentData,
          contractId: contract.id,
          milestoneId: milestone.id,
          clientId,
          orderId: `dev-${uuidv4()}`,
        },
      });
    await markFunded(tx, milestone.id, now);
    return saved;
  });

  return { created: !payment, payment: result };
}

/** `GET /api/payments`: the client's payments, newest first. Writes nothing. */
export function listClientPayments(clientId: string) {
  return prisma.payment.findMany({
    where: { clientId },
    include: {
      contract: {
        include: {
          project: { select: { id: true, title: true } },
          freelancer: { select: { id: true, name: true } },
        },
      },
      milestone: { select: { id: true, sequence: true, title: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
