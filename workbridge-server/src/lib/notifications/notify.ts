import type { Notification } from '@prisma/client';

import type { PrismaTransactionClient } from '../../types/index';
import type { NotificationType } from './types';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  href?: string | null;
}

/**
 * The single entry point for creating notifications in new code. Pass the transaction client
 * of the state change that causes the notification, so both commit or roll back together.
 *
 * Phase 0 keeps this minimal — it only writes the in-app `Notification` row. Phase 3 adds
 * per-user preferences and email delivery here, which is why new code must not call
 * `notification.create` directly: it would silently skip both.
 */
export async function notify(client: PrismaTransactionClient, input: NotifyInput): Promise<Notification> {
  return client.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      href: input.href ?? null,
    },
  });
}

/** {@link notify} for several recipients in one statement. Returns how many rows were written. */
export async function notifyMany(client: PrismaTransactionClient, inputs: readonly NotifyInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const { count } = await client.notification.createMany({
    data: inputs.map((input) => ({
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      href: input.href ?? null,
    })),
  });
  return count;
}
