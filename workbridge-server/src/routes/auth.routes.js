import { Router } from 'express';
import {
  signup,
  login,
  logout,
  refresh,
  googleAuth,
  googleCallback,
  selectRole,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/logout', authenticate, logout);
router.post('/refresh', refresh);
router.post('/select-role', authenticate, selectRole);
router.get('/google', googleAuth);
router.get('/google/callback', googleCallback);

export default router;
