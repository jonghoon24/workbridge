import { z } from 'zod';

/**
 * Request bodies and queries of `/api/auth` (BEHAVIOR.md "Auth"). A failure is a 400
 * `<field>: <message>` for the first failing field (rule 12); the client maps the messages to
 * Korean (`workbridge-client/src/lib/errorMessages.js`), so keep the two in sync.
 */

export const ROLE_MESSAGE = 'Role must be CLIENT or FREELANCER';

/** A required, non-empty string. Not trimmed: email and password are compared verbatim (Q16). */
function requiredString(label: string) {
  return z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .min(1, `${label} is required`);
}

/** `CLIENT` or `FREELANCER`, case-sensitive. Missing, wrong type and unknown value share one message. */
export const roleField = z.enum(['CLIENT', 'FREELANCER'], { errorMap: () => ({ message: ROLE_MESSAGE }) });

/** `POST /signup`. */
export const signupBody = z.object({
  email: requiredString('Email'),
  password: requiredString('Password'),
  name: requiredString('Name').trim().min(1, 'Name is required'),
  role: roleField,
});

/**
 * `POST /login`. Runs after both rate limits (rule 10). A non-string `email` or `password` (an
 * object such as `{ "not": "" }` would otherwise reach Prisma as a filter) is a 400.
 */
export const loginBody = z.object({
  email: requiredString('Email'),
  password: requiredString('Password'),
});

/** `POST /select-role`. */
export const selectRoleBody = z.object({
  role: roleField,
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

/** `GET /google/callback`. */
export const googleCallbackQuery = z.object({
  code: callbackParam,
  state: callbackParam,
});

export type SignupInput = z.infer<typeof signupBody>;
export type LoginInput = z.infer<typeof loginBody>;
export type SelectRoleInput = z.infer<typeof selectRoleBody>;
export type GoogleCallbackQuery = z.infer<typeof googleCallbackQuery>;
