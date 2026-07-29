import { Router } from 'express';
import {
  createPayment,
  confirmPayment,
  completePaymentForDev,
  getPayments,
} from '../controllers/payments.controller.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.post('/', authenticate, createPayment);
router.post('/confirm', authenticate, confirmPayment);
router.post('/dev-complete', authenticate, completePaymentForDev);
router.get('/', authenticate, getPayments);

export default router;
