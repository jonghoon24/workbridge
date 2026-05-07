import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

export async function createPayment(req, res, next) {
  try {
    const { contractId } = req.body;

    if (!contractId) {
      throw new AppError('Contract ID is required', 400);
    }

    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: { payment: true },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    if (contract.status !== 'ACTIVE') {
      throw new AppError('Contract must be active to proceed with payment', 400);
    }

    if (contract.payment?.status === 'COMPLETED') {
      throw new AppError('Payment already completed for this contract', 409);
    }

    if (contract.payment?.status === 'PENDING') {
      return res.json({
        orderId: contract.payment.orderId,
        amount: contract.payment.amount,
        paymentId: contract.payment.id,
      });
    }

    if (contract.payment?.status === 'FAILED') {
      const orderId = uuidv4();
      const payment = await prisma.payment.update({
        where: { id: contract.payment.id },
        data: {
          amount: contract.amount,
          status: 'PENDING',
          paymentKey: null,
          orderId,
        },
      });

      return res.json({ orderId, amount: payment.amount, paymentId: payment.id });
    }

    if (contract.payment) {
      throw new AppError('Payment cannot be created for this contract', 409);
    }

    const orderId = uuidv4();

    const payment = await prisma.payment.create({
      data: {
        contractId,
        clientId: req.user.id,
        amount: contract.amount,
        status: 'PENDING',
        orderId,
      },
    });

    res.status(201).json({ orderId, amount: contract.amount, paymentId: payment.id });
  } catch (err) {
    next(err);
  }
}

export async function confirmPayment(req, res, next) {
  try {
    const { paymentKey, orderId, amount } = req.body;

    if (!paymentKey || !orderId || !amount) {
      throw new AppError('paymentKey, orderId, and amount are required', 400);
    }

    const requestedAmount = Number(amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new AppError('Invalid payment amount', 400);
    }

    const payment = await prisma.payment.findUnique({
      where: { orderId },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    if (payment.status !== 'PENDING') {
      throw new AppError('Payment has already been processed', 409);
    }

    if (requestedAmount !== payment.amount) {
      throw new AppError('Payment amount does not match the contract amount', 400);
    }

    // Verify with Toss Payments
    try {
      const secretKey = process.env.TOSS_SECRET_KEY;
      const credentials = Buffer.from(`${secretKey}:`).toString('base64');

      const { data: tossPayment } = await axios.post(
        'https://api.tosspayments.com/v1/payments/confirm',
        { paymentKey, orderId, amount: requestedAmount },
        { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' } }
      );

      if (Number(tossPayment.totalAmount) !== payment.amount || tossPayment.status !== 'DONE') {
        throw new AppError('Payment verification failed', 400);
      }

      const updated = await prisma.payment.update({
        where: { orderId },
        data: { status: 'COMPLETED', paymentKey },
      });

      res.json(updated);
    } catch (tossError) {
      await prisma.payment.update({
        where: { orderId },
        data: { status: 'FAILED' },
      });

      throw new AppError('Payment verification failed', 400);
    }
  } catch (err) {
    next(err);
  }
}

export async function getPayments(req, res, next) {
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
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(payments);
  } catch (err) {
    next(err);
  }
}
