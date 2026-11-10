import { removeObjects } from '../../lib/attachmentStorage';
import type { JobHandler } from '../types';

/**
 * `attachment.deleteObjects` — removes files from the private attachment bucket: the files of a
 * message its sender deleted, and uploads that expired before anything claimed them
 * (`maintenance.cleanup`). Idempotent: removing a key that is already gone succeeds. A storage
 * failure throws, so the runner retries it.
 */
export const attachmentDeleteObjects: JobHandler<'attachment.deleteObjects'> = async ({ payload, logger }) => {
  await removeObjects(payload.keys);
  logger.info('attachment objects deleted', { count: payload.keys.length });
};
