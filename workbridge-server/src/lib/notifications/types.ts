/**
 * `Notification.type` is a bare `String` in the schema. These are the values ever written
 * (BEHAVIOR.md "Notifications" lists them with recipients and links).
 */
export type NotificationType =
  // Pre-existing; their wording stays inline in the old controllers.
  | 'APPLICATION_CREATED'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REJECTED'
  | 'PROJECT_STATUS_CHANGED'
  // Phase 1; rendered by `templates.ts`.
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
  | 'SETTLEMENT_SCHEDULED'
  | 'SETTLEMENT_PAID'
  | 'SETTLEMENT_ON_HOLD'
  | 'SETTLEMENT_FAILED';
