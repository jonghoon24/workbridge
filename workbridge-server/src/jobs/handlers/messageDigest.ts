import { runUnreadDigest } from '../../services/messaging.service';
import type { JobHandler } from '../types';

/**
 * J8 — the unread-message digest: lock the recipient's participant row, end as a no-op when there
 * is nothing to send, re-enqueue when the oldest unread message is younger than 10 minutes
 * (steps 1–2, Phase 2A); then the 60-minute throttle and the email-only digest through
 * `notify()` (steps 3–4, Phase 3, NC16). The email itself goes out with its `notification.email`
 * job (J9).
 */
export const messageUnreadDigest: JobHandler<'message.unreadDigest'> = async ({ payload, now, logger }) => {
  const result = await runUnreadDigest(payload.conversationId, payload.recipientId, now);
  logger.info('unread digest', {
    conversationId: payload.conversationId,
    recipientId: payload.recipientId,
    outcome: result.outcome,
    unreadCount: result.unreadCount,
    ...(result.nextRunAt ? { nextRunAt: result.nextRunAt.toISOString() } : {}),
  });
};
