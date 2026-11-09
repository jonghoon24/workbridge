import { runUnreadDigest } from '../../services/messaging.service';
import type { JobHandler } from '../types';

/**
 * The unread-message digest (docs/domain/messaging-notifications.md "미확인 메시지 다이제스트"):
 * lock the recipient's participant row, end as a no-op when there is nothing to send, re-enqueue
 * when the oldest unread message is younger than 10 minutes; then the 60-minute throttle and the
 * email-only digest through `notify()`. The email itself goes out with its `notification.email`
 * job.
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
