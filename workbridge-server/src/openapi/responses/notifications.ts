import { NOTIFICATION_TYPES } from '../../lib/notifications/policy';
import type { NotificationType } from '../../lib/notifications/types';
import { z } from '../../lib/zod';
import { count, dateTime, id } from './common';

export const notificationTypeEnum = z
  .enum(NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]])
  .openapi('NotificationType');

/** A `Notification` row. */
export const notification = z
  .object({
    id,
    userId: id,
    type: notificationTypeEnum,
    title: z.string(),
    message: z.string(),
    href: z.string().nullable().openapi({ description: '눌렀을 때 갈 클라이언트 경로' }),
    readAt: dateTime.nullable(),
    createdAt: dateTime,
  })
  .openapi('Notification');

export const notificationList = z.object({
  notifications: z.array(notification).openapi({ description: '최신순' }),
  unreadCount: count,
});

/** The caller's role's notification types in policy order, each with its effective channels. */
export const notificationPreferences = z.object({
  preferences: z.array(
    z
      .object({
        type: notificationTypeEnum,
        category: z.enum(['APPLICATION', 'CONTRACT', 'MILESTONE', 'SETTLEMENT', 'MESSAGE']),
        inApp: z.boolean(),
        email: z.boolean(),
        inAppLocked: z.boolean(),
        emailLocked: z.boolean(),
      })
      .openapi('NotificationPreference'),
  ),
});
