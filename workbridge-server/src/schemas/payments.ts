import { z } from 'zod';

import { bodyNumber, requiredString } from './common';

/**
 * Request bodies of the payment routes (BEHAVIOR.md PY1, PY5, PY10). A `contractId` (or any other
 * extra field) is stripped, so a body with only `contractId` is `milestoneId: Required` (PY1).
 */

/** `POST /api/payments` and `POST /api/payments/dev-complete`. */
export const milestonePaymentBody = z.object({
  milestoneId: requiredString(),
});

const AMOUNT_MESSAGE = 'must be a positive number';

/** `POST /api/payments/confirm`. Whether `amount` matches the stored amount is the controller's. */
export const paymentConfirmBody = z.object({
  paymentKey: requiredString(),
  orderId: requiredString(),
  amount: bodyNumber(AMOUNT_MESSAGE).superRefine((value, ctx) => {
    if (value <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: AMOUNT_MESSAGE });
  }),
});
