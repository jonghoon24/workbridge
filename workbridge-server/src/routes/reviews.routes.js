import { Router } from 'express';
import { createReview, getUserReviews } from '../controllers/reviews.controller.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.post('/', authenticate, createReview);
router.get('/users/:id', getUserReviews);

export default router;
