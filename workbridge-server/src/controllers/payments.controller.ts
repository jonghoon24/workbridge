import type { NextFunction, Response } from 'express';
import { Prisma } from '@prisma/client';
import type { Payment } from '@prisma/client';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { env } from '../env';
import { markFunded } from '../services/milestones.service';
import type { AuthedRequest } from '../types/index';

/**
 * Payments are per milestone (docs/domain/milestones-payments.md "안전결제"). This controller
 * talks to Prisma directly; moving it to a service is #40. Request bodies are parsed by
 * `schemas/payments.ts` in the route, after `requireActiveUser`.
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

export async function createPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `milestonePaymentBody`; a `contractId` in the body is stripped.
    const { milestoneId } = req.body;
    const clientId = req.user.id;

    const { status, order } = await retryOnceOnPaymentConflict(() => openPaymentOrder(milestoneId, clientId));
    res.status(status).json(order);
  } catch (err) {
    next(err);
  }
}

/** Creates, resumes or retries the milestone's payment for `createPayment`. */
async function openPaymentOrder(
  milestoneId: string,
  clientId: string,
): Promise<{ status: 200 | 201; order: PaymentOrder }> {
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
      status: 200,
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
      },
    });

    return { status: 200, order: { orderId, amount: updated.amount, paymentId: updated.id } };
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

  return { status: 201, order: { orderId, amount: created.amount, paymentId: created.id } };
}

export async function confirmPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `paymentConfirmBody`: `amount` is a positive whole number of won.
    const { paymentKey, orderId, amount: requestedAmount } = req.body;

    // A payment whose project is soft-deleted is not found — before anything is captured.
    const payment = await prisma.payment.findFirst({
      where: { orderId, milestone: { contract: { project: { deletedAt: null } } } },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    // Known bug #13: a read followed by an unlocked write; two concurrent confirms can both pass this.
    if (payment.status !== 'PENDING') {
      throw new AppError('Payment has already been processed', 409);
    }

    if (requestedAmount !== payment.amount) {
      throw new AppError('Payment amount does not match the contract amount', 400);
    }

    // Verify with Toss Payments
    try {
      // Deliberately `string | undefined` rather than a required env var: the template
      // literal below stringifies an unset key, so a missing TOSS_SECRET_KEY still surfaces
      // as a 400 "Payment verification failed" from Toss. Kept on purpose — promoting it to
      // required would turn that into a 500 instead.
      const secretKey = env.TOSS_SECRET_KEY;
      const credentials = Buffer.from(`${secretKey}:`).toString('base64');

      const { data: tossPayment } = await axios.post(
        'https://api.tosspayments.com/v1/payments/confirm',
        { paymentKey, orderId, amount: requestedAmount },
        { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' } }
      );

      if (Number(tossPayment.totalAmount) !== payment.amount || tossPayment.status !== 'DONE') {
        throw new AppError('Payment verification failed', 400);
      }

      // The payment and the milestone's funding commit together. `markFunded` is a no-op,
      // never an error, when a concurrent confirm already funded the milestone.
      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const completed = await tx.payment.update({
          where: { orderId },
          data: { status: 'COMPLETED', paymentKey },
        });
        await markFunded(tx, payment.milestoneId, now);
        return completed;
      });

      res.json(updated);
    } catch (tossError) {
      // Known bug #3: the cause is discarded. Any failure after capture — including a database write —
      // lands here too. The FAILED write is conditional on PENDING so a confirm that
      // lost a race never turns the winner's COMPLETED payment back into FAILED.
      await prisma.payment.updateMany({
        where: { orderId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });

      throw new AppError('Payment verification failed', 400);
    }
  } catch (err) {
    next(err);
  }
}

export async function completePaymentForDev(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    // `requirePaymentBypass` has already refused the request unless the bypass is on,
    // and `milestonePaymentBody` parsed the body.
    const { milestoneId } = req.body;
    const clientId = req.user.id;
    const now = new Date();

    const { status, payment } = await retryOnceOnPaymentConflict(
      () => completeMilestonePayment(milestoneId, clientId, now),
    );
    res.status(status).json(payment);
  } catch (err) {
    next(err);
  }
}

/** Completes (or creates) the milestone's payment and funds the milestone, for `completePaymentForDev`. */
async function completeMilestonePayment(
  milestoneId: string,
  clientId: string,
  now: Date,
): Promise<{ status: 200 | 201; payment: Payment }> {
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
      return { status: 200, payment };
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

  return { status: payment ? 200 : 201, payment: result };
}

export async function getPayments(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const payments = await prisma.payment.findMany({
      where: { clientId: req.user.id },
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

    res.json(payments);
  } catch (err) {
    next(err);
  }
}
