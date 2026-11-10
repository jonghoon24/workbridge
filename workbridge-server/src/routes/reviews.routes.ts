import { Router } from 'express';
import { createReview, getUserReviews } from '../controllers/reviews.controller';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { reviewBody } from '../schemas/reviews';

const router = Router();

router.post('/', authenticate, validate({ body: reviewBody }), createReview);
router.get('/users/:id', getUserReviews);

export default router;
