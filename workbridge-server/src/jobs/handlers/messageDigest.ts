import { runUnreadDigest } from '../../services/messaging.service';
import type { JobHandler } from '../types';

/**
 * J8 — the unread-message digest. Phase 2A implements steps 1–2: lock the recipient's participant
 * row, end as a no-op when there is nothing to send, and re-enqueue when the oldest unread
 * message is younger than 10 minutes. Phase 3 adds steps 3–4 (throttle, email); until then a due
 * digest ends `SUCCEEDED` without sending (MG21).
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
