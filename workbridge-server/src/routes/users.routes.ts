import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
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
import { AppError } from '../lib/errors';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { upload } from '../middlewares/upload';
import { validate } from '../middlewares/validate';
import { payoutAccountBody } from '../schemas/settlements';
import { profileUpdateBodyByRole } from '../schemas/users';

const router = Router();

/**
 * `PATCH /me` validates only the caller's role's fields; the other role's are stripped. A role with
 * no schema (a token whose `role` claim is not `CLIENT`/`FREELANCER`) is refused like
 * `requireRole` refuses it — never let through unvalidated.
 */
function validateProfileUpdate(req: Request, res: Response, next: NextFunction) {
  const role = req.user.role;
  const body = Object.hasOwn(profileUpdateBodyByRole, role) ? profileUpdateBodyByRole[role] : undefined;
  if (!body) {
    return next(new AppError('FORBIDDEN_ROLE', 'Insufficient permissions'));
  }
  return validate({ body })(req, res, next);
}

router.get('/me', authenticate, getMe);
// The upload runs before validation (multer fills `req.body`); its errors come first. A
// non-image or oversized file is currently a 500, not a 400.
router.patch('/me', authenticate, requireActiveUser, upload.single('profileImage'), validateProfileUpdate, updateMe);
router.get('/me/applications', authenticate, requireRole('FREELANCER'), getMyApplications);
router.get('/me/bookmarks', authenticate, requireRole('FREELANCER'), getMyBookmarks);
router.get('/me/projects', authenticate, requireRole('CLIENT'), getMyProjects);

// The payout account. Must stay before `/:id`.
const payoutGuard = [authenticate, requireActiveUser, requireRole('FREELANCER')];
router.get('/me/payout-account', ...payoutGuard, getMyPayoutAccount);
router.put('/me/payout-account', ...payoutGuard, validate({ body: payoutAccountBody }), putMyPayoutAccount);
router.delete('/me/payout-account', ...payoutGuard, deleteMyPayoutAccount);

router.get('/:id/reviews', getUserReviews);
router.get('/:id', getUserById);

export default router;
