import { closeExpiredOpenProjects } from '../../lib/projectLifecycle';
import type { JobHandler } from '../types';

/**
 * `project.lifecycleSweep` — the scheduled twin of the lazy sweep on read paths (BEHAVIOR.md
 * rule 7). The sweep is idempotent, so it is harmless when a read path got there first.
 */
export const projectLifecycleSweep: JobHandler<'project.lifecycleSweep'> = async ({ now, logger }) => {
  const closed = await closeExpiredOpenProjects(now);
  if (closed.length > 0) {
    logger.info('lifecycle sweep closed projects', { count: closed.length });
  }
};
