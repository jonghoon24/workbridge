import { Router } from 'express';
import {
  createPayment,
  confirmPayment,
  completePaymentForDev,
  getPayments,
} from '../controllers/payments.controller';
import { authenticate } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { requirePaymentBypass } from '../middlewares/paymentBypass';
import { validate } from '../middlewares/validate';
import { milestonePaymentBody, paymentConfirmBody } from '../schemas/payments';

const router = Router();

// The writes mount `requireActiveUser`. Validation runs before the controller's 404/403/409
// checks.
router.post('/', authenticate, requireActiveUser, validate({ body: milestonePaymentBody }), createPayment);
router.post('/confirm', authenticate, requireActiveUser, validate({ body: paymentConfirmBody }), confirmPayment);
// The bypass check comes before validation: with the bypass off, every request is 403.
router.post(
  '/dev-complete',
  authenticate,
  requireActiveUser,
  requirePaymentBypass,
  validate({ body: milestonePaymentBody }),
  completePaymentForDev,
);
router.get('/', authenticate, getPayments);

export default router;
