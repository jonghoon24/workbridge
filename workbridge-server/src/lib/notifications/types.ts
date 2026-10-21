/**
 * `Notification.type` is a bare `String` in the schema. These are the values ever written;
 * later phases extend the union (and BEHAVIOR.md's list) as they add notification points.
 */
export type NotificationType =
  | 'APPLICATION_CREATED'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REJECTED'
  | 'PROJECT_STATUS_CHANGED';
