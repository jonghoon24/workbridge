import { randomUUID } from 'node:crypto';

import { env } from '../../env';
import { logger } from '../logger';

/**
 * Outgoing email (BEHAVIOR.md NC14). No real mail service is connected (Q24): the only supported
 * `MAIL_PROVIDER` is `log`, which writes each email to the log. Tests swap in a failing provider
 * with `setMailProvider` to exercise the retry path, like `setPayoutProvider`.
 */

export interface MailMessage {
  /** The `EmailDelivery` id — an idempotency key a real provider can use to drop a resend. */
  deliveryId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  /** The provider's id for the message, stored as `providerMessageId`. */
  providerMessageId: string;
}

export interface MailProvider {
  /** Resolves when the provider accepted the email; rejects otherwise. */
  send(message: MailMessage): Promise<MailResult>;
}

/** Development provider: one `info` line `mail.sent` with the full email. Never fails. */
export class LogMailProvider implements MailProvider {
  async send(message: MailMessage): Promise<MailResult> {
    const providerMessageId = `log-${randomUUID()}`;
    logger.info('mail.sent', {
      deliveryId: message.deliveryId,
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      providerMessageId,
    });
    return { providerMessageId };
  }
}

let current: MailProvider = new LogMailProvider();

/** Replaces the provider behind `MAIL_PROVIDER=log` (tests). Returns the previous one. */
export function setMailProvider(provider: MailProvider): MailProvider {
  const previous = current;
  current = provider;
  return previous;
}

export type MailProviderSelection =
  | { supported: true; name: string; provider: MailProvider }
  | { supported: false; name: string };

/**
 * NC14: `MAIL_PROVIDER` read now. Unset, empty or exactly `log` → the log provider (recorded as
 * `log`); anything else is unsupported and carries the value as given, for `EmailDelivery.provider`.
 */
export function selectMailProvider(): MailProviderSelection {
  const configured = env.MAIL_PROVIDER ?? '';
  if (configured === '' || configured === 'log') {
    return { supported: true, name: 'log', provider: current };
  }
  return { supported: false, name: configured };
}

export function unsupportedMailProviderError(name: string): string {
  return `Unsupported MAIL_PROVIDER "${name}"`;
}

let warned = false;

/**
 * Called once at process start (the server, `jobs:run`, `jobs:worker`): a set but unsupported
 * `MAIL_PROVIDER` is reported as one `warn` line and never thrown — the sends that need it fail,
 * not the process (NC14, the lazy-env principle of `src/env.ts`).
 */
export function warnIfUnsupportedMailProvider(): void {
  if (warned) return;
  warned = true;
  const selection = selectMailProvider();
  if (!selection.supported) {
    logger.warn('unsupported MAIL_PROVIDER', { mailProvider: selection.name });
  }
}
