import prisma from '../../lib/prisma';
import { listPublicProfileImages, removePublicObjects } from '../../lib/attachmentStorage';
import type { JobHandler } from '../types';

/**
 * `account.deletePublicFiles` — after a withdrawal, removes the user's images from the public
 * bucket: the paths captured by the withdrawal (current profile and portfolio images) and every
 * profile image the user ever uploaded (replaced ones stay in storage otherwise). Public URLs stay
 * readable by anyone who has them until the file is gone (docs/domain/accounts.md "회원 탈퇴").
 *
 * Does nothing unless the user is soft-deleted, so a job enqueued for a live account can never
 * delete its files. Idempotent: a file already gone is not an error; a storage failure throws and
 * the runner retries.
 */
export const accountDeletePublicFiles: JobHandler<'account.deletePublicFiles'> = async ({ payload, logger }) => {
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { deletedAt: true } });
  if (!user?.deletedAt) {
    logger.info('public files kept', { userId: payload.userId, reason: 'user is active' });
    return;
  }

  const paths = [...new Set([...payload.paths, ...(await listPublicProfileImages(payload.userId))])];
  await removePublicObjects(paths);
  logger.info('public files deleted', { userId: payload.userId, count: paths.length });
};
