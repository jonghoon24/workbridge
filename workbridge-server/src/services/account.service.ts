import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { ACCOUNT_INACTIVE, lockUserRow } from '../lib/locks';
import { publicObjectPath } from '../lib/attachmentStorage';
import { notifyRecipients } from '../lib/notifications/notify';
import { clearPasswordConfirmFailures, recordPasswordConfirmFailure } from '../lib/rateLimitRules';
import { enqueueJob } from '../jobs/queue';
import { assertRecentGoogleReauth } from './reauth.service';
import type { ChangePasswordInput } from '../schemas/auth';
import type { WithdrawalInput } from '../schemas/account';
import type { PrismaTransactionClient } from '../types/index';

/**
 * The signed-in user's own account: changing the password and withdrawing
 * (docs/domain/accounts.md "비밀번호 변경", "회원 탈퇴").
 */

/** Same cost as signup. */
const BCRYPT_ROUNDS = 10;

export const NO_PASSWORD = 'Account has no password';
export const WRONG_CURRENT_PASSWORD = 'Current password is incorrect';
export const PASSWORD_ALREADY_CHANGED = 'Password has already been changed';
const INACTIVE = ACCOUNT_INACTIVE;
export const CURRENT_PASSWORD_REQUIRED = 'Current password is required';
export const WITHDRAWAL_BLOCKED = 'Cannot withdraw while contracts or settlements are unfinished';

/** What a withdrawn account's name becomes; every counterpart view shows it. */
export const WITHDRAWN_USER_NAME = '탈퇴한 회원';

/**
 * What a withdrawn account's email becomes: unique per user, and not an email address at all (no
 * `@`), so signup's email rule refuses it and nobody can register it first to block the withdrawal.
 */
export function withdrawnEmail(userId: string): string {
  return `withdrawn:${userId}`;
}

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

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

export interface WithdrawalBlockers {
  /** Contracts the user is a party to, still `PENDING` (unsigned) or `ACTIVE`, deleted project or not. */
  unfinishedContracts: number;
  /** Approved milestones whose earnings no weekly settlement has picked up yet. */
  unsettledEarnings: number;
  /** Settlements not paid out yet and not on hold: `SCHEDULED`, `PROCESSING`, `FAILED`. */
  unpaidSettlements: number;
  /** Settlements on hold for want of a payout account (`ON_HOLD`). */
  heldSettlements: number;
}

async function countBlockers(client: PrismaTransactionClient, userId: string): Promise<WithdrawalBlockers> {
  const [unfinishedContracts, unsettledEarnings, unpaidSettlements, heldSettlements] = await Promise.all([
    client.contract.count({
      where: { OR: [{ clientId: userId }, { freelancerId: userId }], status: { in: ['PENDING', 'ACTIVE'] } },
    }),
    client.settlementItem.count({ where: { freelancerId: userId, settlementId: null } }),
    client.settlement.count({ where: { freelancerId: userId, status: { in: ['SCHEDULED', 'PROCESSING', 'FAILED'] } } }),
    client.settlement.count({ where: { freelancerId: userId, status: 'ON_HOLD' } }),
  ]);
  return { unfinishedContracts, unsettledEarnings, unpaidSettlements, heldSettlements };
}

const isBlocked = (blockers: WithdrawalBlockers) => Object.values(blockers).some((count) => count > 0);

/** `GET /api/users/me/withdrawal`: whether the caller can withdraw now, and what stands in the way. */
export async function getWithdrawalStatus(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { password: true } });
  if (!user) throw new AppError(INACTIVE, 401);
  const blockers = await countBlockers(prisma, userId);
  return { canWithdraw: !isBlocked(blockers), hasPassword: user.password !== null, blockers };
}

/**
 * The deadlock the withdrawal can still meet: its lock order matches accepting an application, but
 * the lifecycle sweep updates several projects' or applications' rows in no particular order
 * (docs/DATABASE.md). Postgres aborts one side; the withdrawal is retried once.
 */
function isDeadlock(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2034') return true;
  const meta = err.meta as { code?: unknown } | undefined;
  return err.code === 'P2010' && meta?.code === '40P01';
}

/**
 * `POST /api/users/me/withdrawal`. The caller is confirmed outside the transaction, so the check
 * holds no locks: an account with a password by it (bcrypt is slow), a Google-only account by a
 * recent Google re-authentication of its linked Google account. Then one transaction:
 *
 * 1. Locks in the order accepting an application takes them — the caller's projects, then the
 *    applications (theirs and the pending ones on their projects), then the user row — so a
 *    concurrent accept either finishes first (and this sees its contract: 409) or finds its
 *    application gone (404). Never a contract with a withdrawn user.
 * 2. Refuses with 409 while a contract is unfinished or money is still owed (`countBlockers`).
 * 3. Closes what is not a transaction yet: the client's projects without a live contract stop
 *    recruiting — their pending applications are rejected (applicants are told, like a manual
 *    close); those without any contract are deleted, those with only cancelled ones are closed and
 *    kept as the freelancer's record. The freelancer's applications that never became a contract
 *    (pending or rejected) are deleted.
 * 4. Deletes the personal data (portfolio, careers, payout account, bookmarks, inbox, notification
 *    settings), blanks the email records, scrubs the user row and soft-deletes it, and enqueues
 *    the deletion of the public images. Transaction records stay.
 */
export async function withdrawAccount(userId: string, input: WithdrawalInput, now: Date): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, password: true, googleId: true },
  });
  if (!user) throw new AppError(INACTIVE, 401);
  if (user.password !== null) {
    if (!input.currentPassword) throw new AppError(CURRENT_PASSWORD_REQUIRED, 400);
    await confirmCurrentPassword(userId, user.password, input.currentPassword, now);
  } else {
    assertRecentGoogleReauth(user, input.reauthToken, 'withdrawal', now);
  }

  const run = () => prisma.$transaction((tx) => withdrawInTransaction(tx, userId, now));
  try {
    await run();
  } catch (err) {
    if (!isDeadlock(err)) throw err;
    logger.warn('withdrawal deadlocked; retrying once', { userId });
    await run();
  }

  if (user.password !== null) await clearPasswordConfirmFailures(userId);
  logger.info('account withdrawn', { userId });
}

async function withdrawInTransaction(tx: PrismaTransactionClient, userId: string, now: Date): Promise<void> {
  // 1. Locks: Project → Application → User (docs/DATABASE.md "동시성").
  const projects = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Project" WHERE "clientId" = ${userId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`;
  const projectIds = projects.map((p) => p.id);
  await tx.$queryRaw`
    SELECT "id" FROM "Application"
    WHERE "freelancerId" = ${userId} OR ("projectId" = ANY(${projectIds}::text[]) AND "status" = 'PENDING')
    ORDER BY "id" FOR UPDATE`;
  const locked = await lockUserRow(tx, userId);
  if (!locked || locked.deletedAt) throw new AppError(INACTIVE, 401);

  // 2. Nothing may be left in progress or owed.
  if (isBlocked(await countBlockers(tx, userId))) throw new AppError(WITHDRAWAL_BLOCKED, 409);

  // 3a. The client's projects with no live contract (none at all, or only cancelled ones): their
  // pending applicants are told the recruitment closed (the manual close's wording) and their
  // applications rejected. A project without any contract is deleted. One whose contracts were all
  // cancelled stays, closed: the cancelled contract and its conversation are the freelancer's record
  // (docs/domain/accounts.md "막지 않고 정리하는 것"). Projects with a completed contract stay as
  // they are, for the same reason.
  const recruiting = await tx.project.findMany({
    where: { id: { in: projectIds }, contracts: { none: { status: { not: 'CANCELLED' } } } },
    select: { id: true, title: true, _count: { select: { contracts: true } } },
  });
  const recruitingIds = recruiting.map((p) => p.id);
  const pending = await tx.application.findMany({
    where: { projectId: { in: recruitingIds }, status: 'PENDING' },
    select: { projectId: true, freelancer: { select: { id: true, deletedAt: true } } },
  });
  await tx.application.updateMany({
    where: { projectId: { in: recruitingIds }, status: 'PENDING' },
    data: { status: 'REJECTED' },
  });
  await tx.project.updateMany({
    where: { id: { in: recruiting.filter((p) => p._count.contracts === 0).map((p) => p.id) } },
    data: { deletedAt: now },
  });
  await tx.project.updateMany({
    where: {
      id: { in: recruiting.filter((p) => p._count.contracts > 0).map((p) => p.id) },
      status: { in: ['UPCOMING', 'OPEN'] },
    },
    data: { status: 'CLOSED' },
  });
  for (const project of recruiting) {
    const applicants = pending.filter((a) => a.projectId === project.id).map((a) => a.freelancer);
    await notifyRecipients(tx, applicants, {
      type: 'PROJECT_STATUS_CHANGED',
      title: '프로젝트 모집이 마감되었습니다',
      message: `'${project.title}' 프로젝트 모집이 마감되었습니다.`,
      href: '/my/applications',
    }, now);
  }

  // 3b. The freelancer's applications that never became a contract (pending or rejected).
  await tx.application.deleteMany({ where: { freelancerId: userId, contract: { is: null } } });

  // 4. Personal data. Image paths are read before their rows go.
  const [profile, portfolio] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { profileImage: true } }),
    tx.portfolioItem.findMany({ where: { userId }, select: { imageUrl: true } }),
  ]);
  const paths = [profile.profileImage, ...portfolio.map((item) => item.imageUrl)]
    .map(publicObjectPath)
    .filter((path): path is string => path !== null);

  await tx.portfolioItem.deleteMany({ where: { userId } });
  await tx.career.deleteMany({ where: { userId } });
  await tx.payoutAccount.deleteMany({ where: { userId } });
  await tx.projectBookmark.deleteMany({ where: { userId } });
  await tx.notificationPreference.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  // The email records stay (a queued send must still find its row and skips a withdrawn
  // recipient); their address and content go.
  await tx.emailDelivery.updateMany({
    where: { userId },
    data: { toAddress: withdrawnEmail(userId), subject: '', body: '' },
  });

  await tx.user.update({
    where: { id: userId },
    data: {
      name: WITHDRAWN_USER_NAME,
      email: withdrawnEmail(userId),
      password: null,
      googleId: null,
      passwordChangedAt: now,
      profileImage: null,
      bio: null,
      companyName: null,
      businessField: null,
      website: null,
      skills: [],
      activityCategory: null,
      experienceYears: null,
      hourlyRate: null,
      portfolioUrl: null,
      deletedAt: now,
    },
  });

  await enqueueJob(tx, {
    type: 'account.deletePublicFiles',
    payload: { userId, paths },
    dedupeKey: `account.deletePublicFiles:${userId}`,
    runAt: now,
  });
}
