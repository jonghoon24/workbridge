import type { NextFunction, Response } from 'express';

import {
  completePaymentWithoutProvider,
  confirmTossPayment,
  listClientPayments,
  openPayment,
} from '../services/payments.service';
import type { MilestonePaymentInput, PaymentConfirmInput } from '../schemas/payments';
import type { AuthedRequest } from '../types/index';

/**
 * `POST /api/payments`: 201 with a new order, 200 when a PENDING order is resumed or a FAILED one
 * reopened. The body was parsed by `milestonePaymentBody` (a `contractId` in it is stripped).
 */
export async function createPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { milestoneId } = req.body as MilestonePaymentInput;
    const { created, order } = await openPayment(milestoneId, req.user.id);
    res.status(created ? 201 : 200).json(order);
  } catch (err) {
    next(err);
  }
}

/** `POST /api/payments/confirm`. The body was parsed by `paymentConfirmBody`. */
export async function confirmPayment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await confirmTossPayment(req.user.id, req.body as PaymentConfirmInput, new Date()));
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /api/payments/dev-complete`: 201 when the payment row was created, else 200.
 * `requirePaymentBypass` has already refused the request unless the bypass is on, and
 * `milestonePaymentBody` parsed the body.
 */
export async function completePaymentForDev(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { milestoneId } = req.body as MilestonePaymentInput;
    const { created, payment } = await completePaymentWithoutProvider(milestoneId, req.user.id, new Date());
    res.status(created ? 201 : 200).json(payment);
  } catch (err) {
    next(err);
  }
}

/** `GET /api/payments`. */
export async function getPayments(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listClientPayments(req.user.id));
  } catch (err) {
    next(err);
  }
}
