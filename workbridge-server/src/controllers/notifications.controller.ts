import type { NextFunction, Response } from 'express';

import {
  countUnreadNotifications,
  listNotifications,
  readAllNotifications,
  readNotification,
} from '../services/notifications.service';
import type { NotificationListQuery } from '../schemas/notifications';
import type { AuthedRequest } from '../types/index';

/** `GET /api/notifications`. The query was parsed by `notificationListQuery` (1–50, default 20). */
export async function getNotifications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { limit } = res.locals.query as NotificationListQuery;
    res.json(await listNotifications(req.user.id, limit));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/notifications/unread-count`. */
export async function getUnreadNotificationCount(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await countUnreadNotifications(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/notifications/:id/read`. */
export async function markNotificationRead(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await readNotification(req.params.id, req.user.id, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/notifications/read-all`. */
export async function markAllNotificationsRead(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await readAllNotifications(req.user.id, new Date());
    res.json({ message: 'Notifications marked as read' });
  } catch (err) {
    next(err);
  }
}
