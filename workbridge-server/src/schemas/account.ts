import { z } from '../lib/zod';

/**
 * `POST /api/users/me/withdrawal`. `currentPassword` is required of an account that has a
 * password — the service checks that, since the body cannot know — and ignored for a Google-only
 * account (docs/domain/accounts.md "회원 탈퇴").
 */
export const withdrawalBody = z.object({
  currentPassword: z
    .string({ invalid_type_error: 'Current password must be a string' })
    .min(1, 'Current password is required')
    .optional(),
});

export type WithdrawalInput = z.infer<typeof withdrawalBody>;
