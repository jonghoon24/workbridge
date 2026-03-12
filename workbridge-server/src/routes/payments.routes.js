import { Router } from 'express';
import { createPayment, confirmPayment, getPayments } from '../controllers/payments.controller.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.post('/', authenticate, createPayment);
router.post('/confirm', authenticate, confirmPayment);
router.get('/', authenticate, getPayments);

export default router;
