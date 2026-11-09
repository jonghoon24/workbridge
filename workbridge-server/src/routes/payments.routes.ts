import { Router } from 'express';
import {
  createPayment,
  confirmPayment,
  completePaymentForDev,
  getPayments,
} from '../controllers/payments.controller';
import { authenticate } from '../middlewares/auth';
import { requirePaymentBypass } from '../middlewares/paymentBypass';
import { validate } from '../middlewares/validate';
import { milestonePaymentBody, paymentConfirmBody } from '../schemas/payments';

const router = Router();

// Pre-existing routes: `authenticate` only, no `requireActiveUser` — 알려진 불일치 D12 (#7).
// Validation (rule 12) runs before the controller's 404/403/409 checks.
router.post('/', authenticate, validate({ body: milestonePaymentBody }), createPayment);
router.post('/confirm', authenticate, validate({ body: paymentConfirmBody }), confirmPayment);
// The bypass check comes before validation: with the bypass off, every request is 403 (PY10).
router.post(
  '/dev-complete',
  authenticate,
  requirePaymentBypass,
  validate({ body: milestonePaymentBody }),
  completePaymentForDev,
);
router.get('/', authenticate, getPayments);

export default router;
