import { z } from '../../lib/zod';
import { count } from './common';

/** `RunDueJobsResult` (`jobs/runner.ts`). */
export const runJobsResult = z.object({
  claimed: count,
  succeeded: count,
  retried: count,
  failed: count,
  skipped: count.openapi({ description: '가져왔지만 다른 실행기가 먼저 잠근 작업' }),
});

export const health = z.object({ status: z.literal('ok') });
