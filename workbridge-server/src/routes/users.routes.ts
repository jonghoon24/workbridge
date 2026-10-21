import { Router } from 'express';
import {
  getMe,
  updateMe,
  getUserById,
  getMyApplications,
  getMyBookmarks,
  getMyProjects,
} from '../controllers/users.controller';
import { getUserReviews } from '../controllers/reviews.controller';
import {
  deleteMyPayoutAccount,
  getMyPayoutAccount,
  putMyPayoutAccount,
} from '../controllers/payoutAccount.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { upload } from '../middlewares/upload';
import { validate } from '../middlewares/validate';
import { payoutAccountBody } from '../schemas/settlements';

const router = Router();

router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, upload.single('profileImage'), updateMe);
router.get('/me/applications', authenticate, getMyApplications);
router.get('/me/bookmarks', authenticate, getMyBookmarks);
router.get('/me/projects', authenticate, getMyProjects);

// Expansion routes (rule 12): the payout account (PA1–PA7). Must stay before `/:id`.
const payoutGuard = [authenticate, requireActiveUser, requireRole('FREELANCER')];
router.get('/me/payout-account', ...payoutGuard, getMyPayoutAccount);
router.put('/me/payout-account', ...payoutGuard, validate({ body: payoutAccountBody }), putMyPayoutAccount);
router.delete('/me/payout-account', ...payoutGuard, deleteMyPayoutAccount);

router.get('/:id/reviews', getUserReviews);
router.get('/:id', getUserById);

export default router;
