import type { NextFunction, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import type { AuthedRequest } from '../types/index';

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value || '20', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('limit must be a positive integer', 400);
  }
  return Math.min(parsed, 50);
}

export async function getNotifications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // `req.query.limit` is widened by qs to `string | string[] | ParsedQs | ParsedQs[]`.
    // Asserted rather than narrowed so the value reaching `Number.parseInt` is unchanged
    // (a repeated `?limit=1&limit=2` still stringifies exactly as it does today).
    const limit = parseLimit(req.query.limit as string | undefined);

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
