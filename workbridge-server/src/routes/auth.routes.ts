import { Router } from 'express';
import {
  signup,
  login,
  logout,
  refresh,
  googleAuth,
  googleCallback,
  selectRole,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth';
import { rateLimit } from '../middlewares/rateLimit';
import { LOGIN_FAILURE_RULE, LOGIN_IP_RULE } from '../lib/rateLimitRules';

const router = Router();

router.post('/signup', signup);
// Per-IP limit first (counts every attempt), then the email + IP failure limit, which only
// peeks here — `login` records failures itself (BEHAVIOR.md rule 10).
router.post('/login', rateLimit(LOGIN_IP_RULE), rateLimit(LOGIN_FAILURE_RULE, { mode: 'peek' }), login);
router.post('/logout', authenticate, logout);
router.post('/refresh', refresh);
router.post('/select-role', authenticate, selectRole);
router.get('/google', googleAuth);
router.get('/google/callback', googleCallback);

export default router;
