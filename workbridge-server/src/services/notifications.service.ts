import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * The caller's in-app notifications: list, unread count and read marks
 * (docs/domain/messaging-notifications.md). Notifications are written by `notify()` in the
 * transaction of the change that caused them; preferences are `notificationPreferences.service.ts`.
 */

/** The newest `limit` notifications plus the unread count. Writes nothing. */
export async function listNotifications(userId: string, limit: number) {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  return { notifications, unreadCount };
}

/** Writes nothing. */
export async function countUnreadNotifications(userId: string) {
  const unreadCount = await prisma.notification.count({
    where: { userId, readAt: null },
  });

  return { unreadCount };
}

/** Marks one of `userId`'s notifications read at `now`; an already-read one keeps its `readAt`. */
export async function readNotification(notificationId: string, userId: string, now: Date) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });

  // Someone else's notification is 404, not 403, so ids cannot be probed for existence.
  if (!notification) {
    throw new AppError('Notification not found', 404);
  }

  return prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: notification.readAt || now },
  });
}

/** Marks all of `userId`'s unread notifications read at `now`. */
export async function readAllNotifications(userId: string, now: Date) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: now },
  });
}
