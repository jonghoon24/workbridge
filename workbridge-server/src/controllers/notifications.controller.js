import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

function parseLimit(value) {
  const parsed = Number.parseInt(value || '20', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('limit must be a positive integer', 400);
  }
  return Math.min(parsed, 50);
}

export async function getNotifications(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);

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

export async function getUnreadNotificationCount(req, res, next) {
  try {
    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });

    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(req, res, next) {
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

export async function markAllNotificationsRead(req, res, next) {
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
