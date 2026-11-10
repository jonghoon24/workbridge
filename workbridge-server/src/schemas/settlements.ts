import { z } from '../lib/zod';

import { isBankCode } from '../lib/banks';
import { queryEnum } from './common';
import { pageQuery } from './pagination';

/** `GET /api/settlements`. */
export const settlementListQuery = z.object({
  status: queryEnum(['SCHEDULED', 'PROCESSING', 'PAID', 'FAILED', 'ON_HOLD'] as const),
  ...pageQuery,
});

/** `PUT /api/users/me/payout-account`. */
export const payoutAccountBody = z.object({
  bankCode: z.string({ required_error: 'Unknown bank code' }).refine(isBankCode, 'Unknown bank code'),
  accountNumber: z
    .string({ required_error: 'Account number must be 10 to 14 digits' })
    .transform((value) => value.replace(/[-\s]/g, ''))
    .refine((value) => /^\d{10,14}$/.test(value), 'Account number must be 10 to 14 digits'),
  holderName: z
    .string({ required_error: 'Account holder is required' })
    .trim()
    .min(1, 'Account holder is required'),
});
