import prisma from '../../lib/prisma';
import { env } from '../../env';
import { selectMailProvider, unsupportedMailProviderError } from '../../lib/mail/provider';
import { PermanentJobError } from '../errors';
import { EMAIL_DISABLED, isEmailEnabled } from '../gates';
import type { JobHandler } from '../types';

/** NC1: the stored `error` is at most 2,000 characters. */
const MAX_ERROR_LENGTH = 2000;
const RECIPIENT_INACTIVE = 'Recipient is no longer active';

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
}

/**
 * J9 — sends one `EmailDelivery`. The provider call cannot be rolled back, so this is **not** one
 * transaction: every write is a single statement conditional on `status = 'PENDING'` (NC12), and
 * delivery is at least once (the delivery id goes to the provider as an idempotency key).
 * A send that will be retried is left to the queue's backoff; only the job's last attempt marks
 * the delivery `FAILED`. Error-level logging is the queue's (rule 9), never this handler's.
 */
export const notificationEmail: JobHandler<'notification.email'> = async ({ job, payload, now, logger }) => {
  // 1.
  const delivery = await prisma.emailDelivery.findUnique({
    where: { id: payload.deliveryId },
    include: { user: { select: { deletedAt: true } } },
  });
  if (!delivery) throw new PermanentJobError(`email delivery ${payload.deliveryId} does not exist`);
  if (delivery.status !== 'PENDING') return;

  const pending = { id: delivery.id, status: 'PENDING' as const };
  const context = { deliveryId: delivery.id, type: delivery.type, contextKey: delivery.contextKey };

  // J10: email is switched off (`JOB_EMAIL_ENABLED`). Skipped rather than held, so turning it on
  // later does not send a backlog of stale emails (`jobs/gates.ts`).
  if (!isEmailEnabled()) {
    await prisma.emailDelivery.updateMany({ where: pending, data: { status: 'SKIPPED', error: EMAIL_DISABLED } });
    logger.info('email skipped', { ...context, reason: 'disabled' });
    return;
  }

  // 2. Soft-deleted since notify() (NC10). The project's deletion plays no part.
  if (delivery.user.deletedAt) {
    await prisma.emailDelivery.updateMany({ where: pending, data: { status: 'SKIPPED', error: RECIPIENT_INACTIVE } });
    logger.info('email skipped', context);
    return;
  }

  // 3. NC14: an unsupported provider fails permanently, without a provider call or an attempt.
  const selection = selectMailProvider();
  if (!selection.supported) {
    const error = unsupportedMailProviderError(selection.name);
    await prisma.emailDelivery.updateMany({ where: pending, data: { status: 'FAILED', provider: selection.name, error } });
    throw new PermanentJobError(error);
  }

  // 4. Count the attempt just before the call; a delivery that left PENDING meanwhile is done.
  const counted = await prisma.emailDelivery.updateMany({ where: pending, data: { attempts: { increment: 1 } } });
  if (counted.count === 0) return;

  // 5.
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await selection.provider.send({
      deliveryId: delivery.id,
      from: env.MAIL_FROM,
      to: delivery.toAddress,
      subject: delivery.subject,
      text: delivery.body,
    }));
  } catch (err) {
    const lastAttempt = job.attempts >= job.maxAttempts;
    await prisma.emailDelivery.updateMany({
      where: pending,
      data: { error: errorText(err), provider: selection.name, ...(lastAttempt ? { status: 'FAILED' as const } : {}) },
    });
    throw err;
  }

  await prisma.emailDelivery.updateMany({
    where: pending,
    data: { status: 'SENT', sentAt: now, provider: selection.name, providerMessageId, error: null },
  });
  logger.info('email sent', { ...context, provider: selection.name, providerMessageId });
};
