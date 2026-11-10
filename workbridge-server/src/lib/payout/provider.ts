import { randomUUID } from 'node:crypto';

import { logger } from '../logger';
import { maskAccountNumber } from '../banks';

/**
 * Bank transfers for settlement payouts. Real transfers are out of scope:
 * the default provider logs and succeeds. Tests swap in a failing provider with
 * `setPayoutProvider` to exercise the retry path.
 */

export interface TransferRequest {
  settlementId: string;
  /** 1-based attempt number; with `settlementId` it makes a natural idempotency key. */
  attempt: number;
  /** Whole won (the settlement's `netAmount`). */
  amount: number;
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

export interface TransferResult {
  /** The provider's reference for the transfer, stored as `providerReference`. */
  reference: string;
}

export interface PayoutProvider {
  /** Resolves on success; rejects with the failure reason otherwise. */
  transfer(request: TransferRequest): Promise<TransferResult>;
}

export class LogPayoutProvider implements PayoutProvider {
  async transfer(request: TransferRequest): Promise<TransferResult> {
    const reference = `log_${randomUUID()}`;
    logger.info('payout transfer (log provider)', {
      settlementId: request.settlementId,
      attempt: request.attempt,
      amount: request.amount,
      bankCode: request.bankCode,
      // Never log the full account number.
      accountNumberMasked: maskAccountNumber(request.accountNumber),
      reference,
    });
    return { reference };
  }
}

let current: PayoutProvider = new LogPayoutProvider();

export function getPayoutProvider(): PayoutProvider {
  return current;
}

/** Replaces the provider (tests). Returns the previous one so it can be restored. */
export function setPayoutProvider(provider: PayoutProvider): PayoutProvider {
  const previous = current;
  current = provider;
  return previous;
}
