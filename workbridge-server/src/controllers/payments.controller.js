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

    if (contract.payment) {
      throw new AppError('Payment already exists for this contract', 409);
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

    const payment = await prisma.payment.findUnique({
      where: { orderId },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.clientId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    // Verify with Toss Payments
    try {
      const secretKey = process.env.TOSS_SECRET_KEY;
      const credentials = Buffer.from(`${secretKey}:`).toString('base64');

      await axios.post(
        'https://api.tosspayments.com/v1/payments/confirm',
        { paymentKey, orderId, amount },
        { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' } }
      );

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
