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
import { authenticate } from '../middlewares/auth';
import { upload } from '../middlewares/upload';

const router = Router();

router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, upload.single('profileImage'), updateMe);
router.get('/me/applications', authenticate, getMyApplications);
router.get('/me/bookmarks', authenticate, getMyBookmarks);
router.get('/me/projects', authenticate, getMyProjects);
router.get('/:id/reviews', getUserReviews);
router.get('/:id', getUserById);

export default router;
