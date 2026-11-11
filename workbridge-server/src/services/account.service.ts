import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { clearPasswordConfirmFailures, recordPasswordConfirmFailure } from '../lib/rateLimitRules';
import type { ChangePasswordInput } from '../schemas/auth';

/**
 * The signed-in user's own account: changing the password (docs/domain/accounts.md "비밀번호 변경").
 */

/** Same cost as signup. */
const BCRYPT_ROUNDS = 10;

export const NO_PASSWORD = 'Account has no password';
export const WRONG_CURRENT_PASSWORD = 'Current password is incorrect';
export const PASSWORD_ALREADY_CHANGED = 'Password has already been changed';
const INACTIVE = 'Account is no longer active';

/**
 * Checks `password` against the user's hash. A wrong one counts toward
 * `PASSWORD_CONFIRM_FAILURE_RULE` and is a 400 — not a 401, which the client reads as an expired
 * session and answers with a token refresh and a new login.
 */
async function confirmCurrentPassword(userId: string, hash: string, password: string, now: Date): Promise<void> {
  if (await bcrypt.compare(password, hash)) return;
  await recordPasswordConfirmFailure(userId, now);
  throw new AppError(WRONG_CURRENT_PASSWORD, 400);
}

/**
 * Replaces the password and stamps `passwordChangedAt`, which ends every session whose refresh
 * token predates it (`refresh`). Returns the user the caller re-issues this device's tokens for.
 * A Google-only account (no password) cannot change one: 409.
 *
 * One row, written only if the hash is still the one that was checked, so two concurrent changes
 * cannot both succeed: the loser is a 409 (or, if it read the winner's hash, a wrong-password 400).
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  now: Date,
): Promise<Pick<User, 'id' | 'email' | 'role' | 'passwordChangedAt'>> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, email: true, role: true, password: true },
  });
  if (!user) throw new AppError(INACTIVE, 401);
  if (user.password === null) throw new AppError(NO_PASSWORD, 409);

  await confirmCurrentPassword(user.id, user.password, input.currentPassword, now);

  const hash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  const written = await prisma.user.updateMany({
    where: { id: user.id, deletedAt: null, password: user.password },
    data: { password: hash, passwordChangedAt: now },
  });
  if (written.count === 0) throw new AppError(PASSWORD_ALREADY_CHANGED, 409);

  await clearPasswordConfirmFailures(user.id);
  logger.info('password changed', { userId: user.id });

  return { id: user.id, email: user.email, role: user.role, passwordChangedAt: now };
}
