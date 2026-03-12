import { Router } from 'express';
import { getContract, signContract } from '../controllers/contracts.controller.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.get('/:id', authenticate, getContract);
router.post('/:id/sign', authenticate, signContract);

export default router;
