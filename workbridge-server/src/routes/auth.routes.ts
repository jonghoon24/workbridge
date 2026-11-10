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
import { validate } from '../middlewares/validate';
import { LOGIN_FAILURE_RULE, LOGIN_IP_RULE } from '../lib/rateLimitRules';
import { googleCallbackQuery, loginBody, selectRoleBody, signupBody } from '../schemas/auth';

const router = Router();

router.post('/signup', validate({ body: signupBody }), signup);
// Per-IP limit first (counts every attempt), then the email + IP failure limit, which only
// peeks here — `login` records failures itself. Both run before
// validation, so a 400 still counts toward the per-IP limit.
router.post(
  '/login',
  rateLimit(LOGIN_IP_RULE),
  rateLimit(LOGIN_FAILURE_RULE, { mode: 'peek' }),
  validate({ body: loginBody }),
  login,
);
// Public: logging out only clears the refresh cookie, so it must work after the access token expired.
router.post('/logout', logout);
router.post('/refresh', refresh);
router.post('/select-role', authenticate, validate({ body: selectRoleBody }), selectRole);
router.get('/google', googleAuth);
// The callback query schema never fails: every callback failure is a redirect, never a 400.
router.get('/google/callback', validate({ query: googleCallbackQuery }), googleCallback);

export default router;
