import { Router } from 'express';
import {
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../controllers/notifications.controller';
import {
  getMyNotificationPreferences,
  putMyNotificationPreferences,
} from '../controllers/notificationPreferences.controller';
import { authenticate } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { validate } from '../middlewares/validate';
import { preferencesBody } from '../schemas/notificationPreferences';

const router = Router();

router.get('/', authenticate, getNotifications);
router.get('/unread-count', authenticate, getUnreadNotificationCount);
router.patch('/read-all', authenticate, markAllNotificationsRead);
router.patch('/:id/read', authenticate, markNotificationRead);

// Notification preferences (NC5–NC8): expansion routes (rule 12), open to either role. Guards per route rather
// than `router.use`, so unmatched paths stay unmatched (Q10).
const guard = [authenticate, requireActiveUser];
router.get('/preferences', ...guard, getMyNotificationPreferences);
router.put('/preferences', ...guard, validate({ body: preferencesBody }), putMyNotificationPreferences);

export default router;
