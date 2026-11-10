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
import { notificationListQuery } from '../schemas/notifications';
import { preferencesBody } from '../schemas/notificationPreferences';

const router = Router();

router.get('/', authenticate, validate({ query: notificationListQuery }), getNotifications);
router.get('/unread-count', authenticate, getUnreadNotificationCount);
router.patch('/read-all', authenticate, markAllNotificationsRead);
router.patch('/:id/read', authenticate, markNotificationRead);

// Notification preferences: open to either role, behind `requireActiveUser` (the four routes above
// do not mount it yet, #7). Guards per route rather than `router.use`, so unmatched paths stay
// unmatched and reach the final JSON 404.
const guard = [authenticate, requireActiveUser];
router.get('/preferences', ...guard, getMyNotificationPreferences);
router.put('/preferences', ...guard, validate({ body: preferencesBody }), putMyNotificationPreferences);

export default router;
