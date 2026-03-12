import { Router } from 'express';
import {
  getMe,
  updateMe,
  getUserById,
  getMyApplications,
  getMyProjects,
} from '../controllers/users.controller.js';
import { authenticate } from '../middlewares/auth.js';
import { upload } from '../middlewares/upload.js';

const router = Router();

router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, upload.single('profileImage'), updateMe);
router.get('/me/applications', authenticate, getMyApplications);
router.get('/me/projects', authenticate, getMyProjects);
router.get('/:id', getUserById);

export default router;
