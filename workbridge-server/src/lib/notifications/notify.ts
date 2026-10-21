import { randomUUID } from 'node:crypto';
import type { Notification, PrismaClient } from '@prisma/client';

import { enqueueJobs } from '../../jobs/queue';
import type { PrismaTransactionClient } from '../../types/index';
import { effectiveChannels } from './policy';
import { renderEmail } from './templates';
import type { NotificationType } from './types';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  href?: string | null;
  /** `conversation:<id>` for the digest (NC16); `null` otherwise. Stored on the email only. */
  contextKey?: string | null;
}

/**
 * The single way notifications are created (BEHAVIOR.md NC9). Per recipient and type it applies
 * the channel policy and the recipient's preferences (NC2–NC3): an in-app `Notification` row
 * when in-app is on, and an `EmailDelivery` plus its `notification.email` job (J9) when email is
 * on and the recipient is active with an address (NC10).
 *
 * Pass the transaction client of the state change that causes the notification, so the row,
 * the delivery and the job commit or roll back with it. Given the root client instead, it opens
 * a transaction of its own so one notice's writes still commit together. `now` becomes the
 * delivery's `createdAt` and the job's `runAt` — a job passes `ctx.now`, which keeps the digest
 * throttle exact under `runDueJobs({ now })`.
 *
 * Returns the in-app row, or `null` when in-app is off for this recipient and type.
 */
export async function notify(
  client: PrismaTransactionClient,
  input: NotifyInput,
  now: Date = new Date(),
): Promise<Notification | null> {
  const [created] = await deliver(client, [input], now);
  return created ?? null;
}

/**
 * {@link notify} for several recipients, with one query per table rather than per recipient.
 * Returns the number of in-app rows written.
 */
export async function notifyMany(
  client: PrismaTransactionClient,
  inputs: readonly NotifyInput[],
  now: Date = new Date(),
): Promise<number> {
  if (inputs.length === 0) return 0;
  return (await deliver(client, inputs, now)).length;
}

/** A notification recipient as loaded alongside the state change: id and soft-delete marker. */
export interface Recipient {
  id: string;
  deletedAt: Date | null;
}

/**
 * Notifies every recipient that is **not soft-deleted** (BEHAVIOR.md rule 5: Phase 1 and later
 * notifications are never addressed to a deleted user; the state change still happens).
 * Returns how many in-app rows were written.
 */
export async function notifyRecipients(
  client: PrismaTransactionClient,
  recipients: readonly Recipient[],
  input: Omit<NotifyInput, 'userId'>,
  now: Date = new Date(),
): Promise<number> {
  return notifyMany(
    client,
    recipients.filter((r) => r.deletedAt === null).map((r) => ({ ...input, userId: r.id })),
    now,
  );
}

/** Runs `fn` in `client`'s transaction, or opens one when `client` is the root client. */
function withTransaction<R>(client: PrismaTransactionClient, fn: (tx: PrismaTransactionClient) => Promise<R>): Promise<R> {
  const root = client as Partial<Pick<PrismaClient, '$transaction'>>;
  if (typeof root.$transaction === 'function') {
    return (client as PrismaClient).$transaction((tx) => fn(tx));
  }
  return fn(client);
}

/** NC9 steps 1–3 for every input. Returns the in-app rows written, in input order. */
function deliver(client: PrismaTransactionClient, inputs: readonly NotifyInput[], now: Date): Promise<Notification[]> {
  return withTransaction(client, async (tx) => {
    const userIds = [...new Set(inputs.map((input) => input.userId))];
    const types = [...new Set(inputs.map((input) => input.type))];

    // 1. Recipients and their preference rows — read once, without a lock (NC7).
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, deletedAt: true },
    });
    const preferences = await tx.notificationPreference.findMany({
      where: { userId: { in: userIds }, type: { in: types } },
      select: { userId: true, type: true, inApp: true, email: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    const stored = new Map(preferences.map((row) => [`${row.userId}:${row.type}`, row]));

    const planned = inputs.map((input) => ({
      input,
      channels: effectiveChannels(input.type, stored.get(`${input.userId}:${input.type}`)),
      notificationId: randomUUID(),
    }));

    // 2. In-app rows. Ids are assigned here so each delivery can point at its own row.
    const inApp = planned.filter((p) => p.channels.inApp);
    const notifications = inApp.length === 0
      ? []
      : await tx.notification.createManyAndReturn({
        data: inApp.map(({ input, notificationId }) => ({
          id: notificationId,
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          href: input.href ?? null,
        })),
      });
    const createdById = new Map(notifications.map((row) => [row.id, row]));

    // 3. Email: on, to an active recipient (NC10) with a non-empty address.
    const deliveries = planned.flatMap(({ input, channels, notificationId }) => {
      const user = userById.get(input.userId);
      if (!channels.email || !user || user.deletedAt || user.email.trim() === '') return [];
      const { subject, body } = renderEmail(input);
      return [{
        id: randomUUID(),
        userId: input.userId,
        notificationId: channels.inApp ? notificationId : null,
        type: input.type,
        toAddress: user.email,
        subject,
        body,
        contextKey: input.contextKey ?? null,
        status: 'PENDING' as const,
        createdAt: now,
      }];
    });
    if (deliveries.length > 0) {
      await tx.emailDelivery.createMany({ data: deliveries });
      await enqueueJobs(tx, deliveries.map((delivery) => ({
        type: 'notification.email' as const,
        payload: { deliveryId: delivery.id },
        runAt: now,
        dedupeKey: `notification.email:${delivery.id}`,
      })));
    }

    return inApp.map(({ notificationId }) => createdById.get(notificationId)).filter((row): row is Notification => !!row);
  });
}
