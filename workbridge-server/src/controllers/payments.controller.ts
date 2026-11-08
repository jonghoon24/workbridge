import type { NextFunction, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { env } from '../env';
import { markFunded } from '../services/milestones.service';
import type { AuthedRequest } from '../types/index';

/**
 * Payments are per milestone (BEHAVIOR.md "Payments", PY1–PY12, [C1]). This is a pre-existing
 * controller: hand-written validation, no zod, no `requireActiveUser` — 알려진 불일치 D12 (#7).
 * Moving it to services + zod is #40.
 */

const isPaymentBypassEnabled = () =>
  env.ALLOW_PAYMENT_BYPASS === 'true';

/**
 * The milestone a payment request names, with what the checks need. Missing, or its contract's
 * project soft-deleted → 404 (rule 5). The id is not validated yet: a non-string id reaches Prisma
 * and is a 500 — 알려진 불일치 D14 (#9), and the [C7] logging vector.
 */
async function findMilestoneForPayment(milestoneId: unknown) {
  const milestone = await prisma.milestone.findFirst({
    where: { id: milestoneId as string, contract: { project: { deletedAt: null } } },
    include: { contract: true, payment: true },
  });
  if (!milestone) {
    throw new AppError('Milestone not found', 404);
  }
  return milestone;
}

/** M13: any lower-sequence milestone still PENDING blocks funding this one. */
async function hasUnfundedPredecessor(contractId: string, sequence: number): Promise<boolean> {
  const count = await prisma.milestone.count({
    where: { contractId, sequence: { lt: sequence }, status: 'PENDING' },
  });
  return count > 0;
}

export async function createPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // A `contractId` in the body is ignored (PY1).
    const { milestoneId } = req.body;

    if (!milestoneId) {
      throw new AppError('Milestone ID is required', 400);
    }

    const milestone = await findMilestoneForPayment(milestoneId);
    const { contract, payment } = milestone;

    if (contract.clientId !== req.user.id) {
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
      return res.json({
        orderId: payment.orderId,
        amount: payment.amount,
        paymentId: payment.id,
      });
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

      return res.json({ orderId, amount: updated.amount, paymentId: updated.id });
    }

    if (payment) {
      // REFUNDED
      throw new AppError('Payment cannot be created for this milestone', 409);
    }

    const orderId = uuidv4();

    // 알려진 불일치 D13 (#8): `Payment.milestoneId` is unique and a concurrent duplicate's P2002 is not caught.
    const created = await prisma.payment.create({
      data: {
        contractId: contract.id,
        milestoneId: milestone.id,
        clientId: req.user.id,
        amount: milestone.amount,
        status: 'PENDING',
        orderId,
      },
    });

    res.status(201).json({ orderId, amount: created.amount, paymentId: created.id });
  } catch (err) {
    next(err);
  }
}

export async function confirmPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { paymentKey, orderId, amount } = req.body;

    if (!paymentKey || !orderId || !amount) {
      throw new AppError('paymentKey, orderId, and amount are required', 400);
    }

    const requestedAmount = Number(amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new AppError('Invalid payment amount', 400);
    }

    // PY5: a payment whose project is soft-deleted is not found — before anything is captured.
    const payment = await prisma.payment.findFirst({
      where: { orderId, milestone: { contract: { project: { deletedAt: null } } } },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    // 알려진 불일치 D18 (#13): a read followed by an unlocked write; two concurrent confirms can both pass this.
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
      // as a 400 "Payment verification failed" from Toss. Behavior preserved from the JS
      // version — promoting it to required would turn that into a 500 instead.
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

      // PY6: the payment and the milestone's funding commit together. `markFunded` is a no-op,
      // never an error, when a concurrent confirm already funded the milestone (PY7).
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
      // 알려진 불일치 D8 (#3): the cause is discarded. Any failure after capture — including a database write —
      // lands here too (PY8). The FAILED write is conditional on PENDING so a confirm that
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
    if (!isPaymentBypassEnabled()) {
      throw new AppError('Payment bypass is disabled', 403);
    }

    const { milestoneId } = req.body;

    if (!milestoneId) {
      throw new AppError('Milestone ID is required', 400);
    }

    const milestone = await findMilestoneForPayment(milestoneId);
    const { contract, payment } = milestone;

    if (contract.clientId !== req.user.id) {
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
        return res.json(payment);
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

    // PY11: complete in place (or create) and fund the milestone in one transaction.
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const saved = payment
        ? await tx.payment.update({ where: { id: payment.id }, data: paymentData })
        : await tx.payment.create({
          data: {
            ...paymentData,
            contractId: contract.id,
            milestoneId: milestone.id,
            clientId: req.user.id,
            orderId: `dev-${uuidv4()}`,
          },
        });
      await markFunded(tx, milestone.id, now);
      return saved;
    });

    res.status(payment ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
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
