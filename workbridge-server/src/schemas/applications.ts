import { z } from 'zod';

import { bodyEnum, bodyNumber, requiredString } from './common';

/** Request bodies of the application routes (BEHAVIOR.md § Applications, rules 8 and 12). */

const RATE_MESSAGE = 'must be a positive number';

/**
 * `POST /api/projects/:id/applications`. `expectedRate` is a positive number of at least 1 — a
 * rate that rounds to 0 won would create a milestone that can never be paid (M7, [C2]).
 */
export const applicationCreateBody = z.object({
  coverLetter: requiredString(),
  expectedRate: bodyNumber(RATE_MESSAGE).superRefine((value, ctx) => {
    if (value <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: RATE_MESSAGE });
    } else if (value < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be at least 1' });
    }
  }),
  expectedDuration: requiredString(),
});

/** `PATCH /api/projects/:projectId/applications/:appId`. */
export const applicationDecisionBody = z.object({
  status: bodyEnum(['ACCEPTED', 'REJECTED'] as const),
});
