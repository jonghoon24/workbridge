import { z } from 'zod';

import { bodyWholeWon, requiredString } from './common';

/**
 * Request bodies of the payment routes (BEHAVIOR.md PY1, PY5, PY10). A `contractId` (or any other
 * extra field) is stripped, so a body with only `contractId` is `Milestone ID is required` (PY1).
 */

/** `POST /api/payments` and `POST /api/payments/dev-complete`. */
export const milestonePaymentBody = z.object({
  milestoneId: requiredString('Milestone ID'),
});

/**
 * `POST /api/payments/confirm`. `amount` is a whole number of won of at least 1; whether it
 * matches the stored amount is the controller's check.
 */
export const paymentConfirmBody = z.object({
  paymentKey: requiredString('Payment key'),
  orderId: requiredString('Order ID'),
  amount: bodyWholeWon('Amount', { min: 1 }),
});
