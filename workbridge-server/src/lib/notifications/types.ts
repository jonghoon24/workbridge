/**
 * `Notification.type` (and `NotificationPreference.type`, `EmailDelivery.type`) is a bare
 * `String` in the schema. These are the values ever written: 20 in-app types plus the email-only
 * digest, with their channel policy in `policy.ts` (docs/domain/messaging-notifications.md).
 */
export type NotificationType =
  // Applications and project status; their wording is inline in their controllers.
  | 'APPLICATION_CREATED'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REJECTED'
  | 'PROJECT_STATUS_CHANGED'
  // Contracts, milestones and settlements; rendered by `templates.ts`.
  | 'CONTRACT_ACTIVATED'
  | 'MILESTONE_PLAN_UPDATED'
  | 'MILESTONE_FUNDED'
  | 'MILESTONE_SUBMITTED'
  | 'MILESTONE_REVISION_REQUESTED'
  | 'MILESTONE_APPROVED'
  | 'MILESTONE_AUTO_APPROVED'
  | 'MILESTONE_AUTO_APPROVE_REMINDER'
  | 'MILESTONE_DUE_SOON'
  | 'MILESTONE_OVERDUE'
  | 'CONTRACT_COMPLETED'
  | 'CONTRACT_CANCELLED'
  | 'SETTLEMENT_SCHEDULED'
  | 'SETTLEMENT_PAID'
  | 'SETTLEMENT_ON_HOLD'
  | 'SETTLEMENT_FAILED'
  // Messages; email only — never an in-app row.
  | 'MESSAGE_UNREAD_DIGEST';
