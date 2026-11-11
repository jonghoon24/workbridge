import { z } from '../lib/zod';

/**
 * `POST /api/users/me/withdrawal`. An account with a password confirms with `currentPassword`; a
 * Google-only account with `reauthToken`, the proof of a fresh Google sign-in that
 * `GET /api/auth/google/reauth` leads to. Which one is required is the service's check, since the
 * body cannot know; the other is ignored (docs/domain/accounts.md "회원 탈퇴").
 */
export const withdrawalBody = z.object({
  currentPassword: z
    .string({ invalid_type_error: 'Current password must be a string' })
    .min(1, 'Current password is required')
    .optional(),
  reauthToken: z
    .string({ invalid_type_error: 'Reauth token must be a string' })
    .min(1, 'Google re-authentication is required')
    .optional(),
});

export type WithdrawalInput = z.infer<typeof withdrawalBody>;
