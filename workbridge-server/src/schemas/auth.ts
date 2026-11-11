import { normalizeEmail } from '../lib/email';
import { REAUTH_PURPOSES } from '../lib/reauth';
import { z } from '../lib/zod';
import { fieldCode } from './common';

/**
 * Request bodies and queries of `/api/auth`. A failure is a 400
 * `<field>: <message>` for the first failing field; the client maps the messages to
 * Korean (`workbridge-client/src/lib/errorMessages.js`), so keep the two in sync.
 */

export const ROLE_MESSAGE = 'Role must be CLIENT or FREELANCER';

/** Signup only — login takes any password, so accounts created before the rule keep working. */
export const MIN_PASSWORD_LENGTH = 8;

/** A required, non-empty string, not trimmed (the email fields normalize on top of it; passwords are verbatim). */
function requiredString(label: string) {
  return z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .min(1, `${label} is required`);
}

/** `CLIENT` or `FREELANCER`, case-sensitive. Missing, wrong type and unknown value share one message. */
export const roleField = z.enum(['CLIENT', 'FREELANCER'], { errorMap: () => ({ message: ROLE_MESSAGE }) });

/**
 * A new password, by the signup rule (`MIN_PASSWORD_LENGTH` characters). Signup and changing the
 * password share it, so there is one rule for every password a user sets.
 */
function newPasswordField(label: string) {
  return requiredString(label).min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

/**
 * `POST /signup`. The email must look like an address and is normalized (`normalizeEmail`: trimmed
 * and lowercased) before it is stored or checked for duplicates. The password needs
 * `MIN_PASSWORD_LENGTH` characters, the same rule as the client's signup form.
 */
export const signupBody = z.object({
  email: requiredString('Email')
    .trim()
    .min(1, 'Email is required')
    .email('Email must be a valid email address')
    .transform(normalizeEmail),
  password: newPasswordField('Password'),
  name: requiredString('Name').trim().min(1, 'Name is required'),
  role: roleField,
});

/**
 * `POST /login`. Runs after both login rate limits. A non-string `email` or `password` (an
 * object such as `{ "not": "" }` would otherwise reach Prisma as a filter) is a 400. The email is
 * normalized like signup's (trimmed and lowercased), so the address matches however it is typed.
 * No format or length rule: a malformed email simply matches no account (401), and older
 * passwords still work.
 */
export const loginBody = z.object({
  email: requiredString('Email').trim().min(1, 'Email is required').transform(normalizeEmail),
  password: requiredString('Password'),
});

/** `POST /select-role`. */
export const selectRoleBody = z.object({
  role: roleField,
});

export const SAME_PASSWORD_MESSAGE = 'New password must be different from the current password';

/**
 * `POST /change-password`. The current password takes any value (like login — an account from
 * before the signup rule can still change it); the new one follows the signup rule and must differ
 * from the current one. Whether the current one is right is the service's check, after validation.
 */
export const changePasswordBody = z
  .object({
    currentPassword: requiredString('Current password'),
    newPassword: newPasswordField('New password'),
  })
  .superRefine((body, ctx) => {
    if (body.newPassword === body.currentPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['newPassword'], message: SAME_PASSWORD_MESSAGE, params: fieldCode('CONFLICT') });
    }
  });

/**
 * One OAuth callback parameter. **Never fails:** every callback failure must degrade to the
 * `oauth_failed` redirect, never a 400 — so an absent, empty, repeated or nested value simply
 * reads as absent, and the controller redirects.
 */
const callbackParam = z.preprocess(
  (value) => (typeof value === 'string' && value !== '' ? value : undefined),
  z.string().optional(),
);

/** `GET /google/callback`. `error` is Google's (`access_denied` when the user cancels). */
export const googleCallbackQuery = z.object({
  code: callbackParam,
  state: callbackParam,
  error: callbackParam,
});

/** `GET /google/reauth`. The purpose picks the screen the callback returns to. */
export const googleReauthQuery = z.object({
  purpose: z.enum(REAUTH_PURPOSES, {
    errorMap: () => ({ message: `Purpose must be one of: ${REAUTH_PURPOSES.join(', ')}` }),
  }),
});

export type SignupInput = z.infer<typeof signupBody>;
export type LoginInput = z.infer<typeof loginBody>;
export type SelectRoleInput = z.infer<typeof selectRoleBody>;
export type ChangePasswordInput = z.infer<typeof changePasswordBody>;
export type GoogleCallbackQuery = z.infer<typeof googleCallbackQuery>;
export type GoogleReauthQuery = z.infer<typeof googleReauthQuery>;
