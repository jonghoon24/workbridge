import { z } from '../lib/zod';

export const runJobsBody = z.object({
  limit: z.number().int().min(1).max(500).default(50),
});

export type RunJobsBody = z.infer<typeof runJobsBody>;
