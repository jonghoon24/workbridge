import type { NextFunction, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import type { AuthedRequest } from '../types/index';
import type { NotificationListQuery } from '../schemas/notifications';

export async function getNotifications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by `notificationListQuery`: 1–50, default 20.
    const { limit } = res.locals.query as NotificationListQuery;

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({
        where: { userId: req.user.id, readAt: null },
      }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function getUnreadNotificationCount(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });

    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!notification) {
      throw new AppError('Notification not found', 404);
    }

    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: notification.readAt || new Date() },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function markAllNotificationsRead(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    res.json({ message: 'Notifications marked as read' });
  } catch (err) {
    next(err);
  }
}
